import type {
  CheckConclusion,
  CheckRun,
  QualityGatePort,
} from '../../domain/ports/quality-gate.port.js';
import {
  VcsError,
  type CommitFile,
  type PullRequestRef,
  type VcsPort,
} from '../../domain/ports/vcs.port.js';

export interface GitHubRestOptions {
  /** PAT fine-grained con Contents y Pull requests en Read and write. */
  token: string;
  baseUrl?: string;
  /** Inyectable para los tests. */
  fetch?: typeof fetch;
}

/**
 * GitHub por su API REST, sin clonar.
 *
 * La spec 003 proponia el servidor MCP de GitHub para el PR y git para el
 * push. Se fue por la REST para las dos cosas (ADR 0012):
 *
 * - El commit se arma con la Git Data API (tree + commit + ref) a partir de
 *   los archivos de `run_artifacts`. No hay clon, ni directorio temporal, ni
 *   binario de git en el host del worker.
 * - Una sola credencial (el PAT) en vez de PAT para git + OAuth para MCP.
 *
 * El token viaja SOLO en el header Authorization. Nunca en una URL (las URLs
 * terminan en logs) y nunca en un mensaje de error: se tacha aunque GitHub lo
 * devuelva en el cuerpo.
 */
export class GitHubRestAdapter implements VcsPort, QualityGatePort {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: GitHubRestOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.github.com';
    this.fetchFn = options.fetch ?? fetch;
  }

  async checkAccess(repo: string): Promise<void> {
    await this.request('GET', `/repos/${repo}`);
  }

  async commitFiles(input: {
    repo: string;
    branch: string;
    base: string;
    message: string;
    files: CommitFile[];
    createOnly: boolean;
  }): Promise<{ sha: string }> {
    const { repo, branch } = input;

    const existing = await this.findRef(repo, branch);
    if (existing && input.createOnly) {
      throw new VcsError('branch_exists', `La rama ${branch} ya existe en ${repo}`);
    }
    const parent = existing ?? (await this.findRef(repo, input.base));
    if (!parent) {
      throw new VcsError('not_found', `No existe la rama base ${input.base} en ${repo}`);
    }

    const parentCommit = await this.request<{ tree: { sha: string } }>(
      'GET',
      `/repos/${repo}/git/commits/${parent}`,
    );
    // base_tree: los archivos se SUMAN al arbol del padre. Sin esto, el
    // commit tendria solo lo que escribio el agente y borraria el resto.
    const tree = await this.request<{ sha: string }>('POST', `/repos/${repo}/git/trees`, {
      base_tree: parentCommit.tree.sha,
      tree: input.files.map((f) => ({
        path: f.path,
        mode: '100644',
        type: 'blob',
        content: f.content,
      })),
    });
    const commit = await this.request<{ sha: string }>('POST', `/repos/${repo}/git/commits`, {
      message: input.message,
      tree: tree.sha,
      parents: [parent],
    });

    if (existing) {
      // force: false. Si alguien empujo a la rama mientras tanto, mejor fallar
      // que pisar su trabajo.
      await this.request('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, {
        sha: commit.sha,
        force: false,
      });
    } else {
      try {
        await this.request('POST', `/repos/${repo}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: commit.sha,
        });
      } catch (err) {
        // Otro la creo entre la lectura y esta escritura.
        if (err instanceof GitHubHttpError && err.status === 422) {
          throw new VcsError('branch_exists', `La rama ${branch} ya existe en ${repo}`);
        }
        throw err;
      }
    }
    return { sha: commit.sha };
  }

  async findOpenPullRequest(repo: string, branch: string): Promise<PullRequestRef | null> {
    const owner = repo.split('/')[0];
    const params = new URLSearchParams({ head: `${owner}:${branch}`, state: 'open' });
    const prs = await this.request<Array<{ number: number; html_url: string }>>(
      'GET',
      `/repos/${repo}/pulls?${params}`,
    );
    const pr = prs[0];
    return pr ? { number: pr.number, url: pr.html_url } : null;
  }

  async openPullRequest(input: {
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const pr = await this.request<{ number: number; html_url: string }>(
      'POST',
      `/repos/${input.repo}/pulls`,
      { title: input.title, head: input.branch, base: input.base, body: input.body },
    );
    return { number: pr.number, url: pr.html_url };
  }

  /**
   * Los check runs del HEAD del PR.
   *
   * Del HEAD y no de "el PR": en un ciclo de correccion el PR es el mismo y
   * el commit no. Los checks del commit anterior ya no dicen nada.
   */
  async fetchChecks(repo: string, prNumber: number): Promise<CheckRun[]> {
    const pr = await this.request<{ head: { sha: string } }>(
      'GET',
      `/repos/${repo}/pulls/${prNumber}`,
    );
    const res = await this.request<{ check_runs: GitHubCheckRun[] }>(
      'GET',
      `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
    );
    return res.check_runs.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      summary: summarize(c.output),
    }));
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  /** El sha de una rama, o null si no existe. */
  private async findRef(repo: string, branch: string): Promise<string | null> {
    try {
      const ref = await this.request<{ object: { sha: string } }>(
        'GET',
        `/repos/${repo}/git/ref/heads/${branch}`,
      );
      return ref.object.sha;
    } catch (err) {
      if (err instanceof VcsError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new VcsError('unavailable', this.redact(`GitHub no respondio: ${String(err)}`));
    }

    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    const detail = this.redact(await errorMessage(res));
    const where = `${method} ${path.split('?')[0]}`;
    switch (res.status) {
      case 401:
        throw new VcsError('forbidden', `GitHub rechazo el token (401) en ${where}. ¿Vencio?`);
      case 403:
        throw new VcsError(
          'forbidden',
          `Sin permiso (403) en ${where}: ${detail}. Al token le falta ` +
            '"Contents: Read and write" o "Pull requests: Read and write" sobre el repo.',
        );
      case 404:
        throw new VcsError('not_found', `No encontrado (404) en ${where}: ${detail}`);
      case 422:
        throw new GitHubHttpError(422, `GitHub rechazo la operacion (422) en ${where}: ${detail}`);
      default:
        throw new VcsError('unavailable', `GitHub respondio ${res.status} en ${where}: ${detail}`);
    }
  }

  private redact(text: string): string {
    return this.options.token ? text.split(this.options.token).join('***') : text;
  }
}

/** 422 es ambiguo (rama existente, PR duplicado...): lo interpreta quien llama. */
class GitHubHttpError extends VcsError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super('unavailable', message);
  }
}

interface GitHubCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: CheckConclusion | null;
  output?: { title?: string | null; summary?: string | null };
}

function summarize(output: GitHubCheckRun['output']): string | undefined {
  const parts = [output?.title, output?.summary].filter((p): p is string => !!p?.trim());
  return parts.length > 0 ? parts.join(': ') : undefined;
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { message?: string };
    return json.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
