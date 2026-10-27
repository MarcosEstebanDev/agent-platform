import test from 'node:test';
import assert from 'node:assert/strict';
import { VcsError } from '../../domain/ports/vcs.port.js';
import { GitHubRestAdapter } from './github-rest.adapter.js';

const TOKEN = 'github_pat_NO_DEBE_APARECER';

interface Call {
  method: string;
  path: string;
  body?: unknown;
  auth?: string | null;
}

/**
 * Un GitHub de mentira a nivel HTTP: rutas -> respuestas. Lo que se prueba
 * aca es el contrato con la API real (que endpoints, en que orden, como se
 * traducen los errores), no la logica de negocio, que ya vive en los tests de
 * los casos de uso.
 */
function fakeGitHub(routes: Record<string, (call: Call) => { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    const handler = routes[key];
    const res = handler ? handler(call) : { status: 404, body: { message: 'Not Found' } };
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, adapter: new GitHubRestAdapter({ token: TOKEN, fetch: fetchFn }) };
}

const R = '/repos/marcos/sandbox';

// ─── Commit sin clonar ──────────────────────────────────────────────────────

test('rama nueva: tree + commit sobre la base, y crea la ref', async () => {
  const { calls, adapter } = fakeGitHub({
    [`GET ${R}/git/ref/heads/main`]: () => ({ status: 200, body: { object: { sha: 'base-sha' } } }),
    [`GET ${R}/git/commits/base-sha`]: () => ({ status: 200, body: { tree: { sha: 'base-tree' } } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: 'new-tree' } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: 'new-commit' } }),
    [`POST ${R}/git/refs`]: () => ({ status: 201, body: {} }),
  });

  const { sha } = await adapter.commitFiles({
    repo: 'marcos/sandbox',
    branch: 'feature/TICKET-1',
    base: 'main',
    message: 'msg',
    files: [{ path: 'a.mjs', content: 'x' }],
    createOnly: true,
  });

  assert.equal(sha, 'new-commit');
  const tree = calls.find((c) => c.path.endsWith('/git/trees'))!.body as Record<string, unknown>;
  assert.equal(tree.base_tree, 'base-tree', 'los archivos se suman al repo, no lo reemplazan');
  assert.deepEqual(tree.tree, [{ path: 'a.mjs', mode: '100644', type: 'blob', content: 'x' }]);
  const commit = calls.find((c) => c.path.endsWith('/git/commits'))!.body as Record<string, unknown>;
  assert.deepEqual(commit.parents, ['base-sha']);
  const ref = calls.find((c) => c.path.endsWith('/git/refs'))!.body as Record<string, unknown>;
  assert.deepEqual(ref, { ref: 'refs/heads/feature/TICKET-1', sha: 'new-commit' });
});

test('rama existente con createOnly: branch_exists, sin escribir nada', async () => {
  const { calls, adapter } = fakeGitHub({
    [`GET ${R}/git/ref/heads/feature/TICKET-1`]: () => ({
      status: 200,
      body: { object: { sha: 'ajeno' } },
    }),
  });

  await assert.rejects(
    () =>
      adapter.commitFiles({
        repo: 'marcos/sandbox',
        branch: 'feature/TICKET-1',
        base: 'main',
        message: 'm',
        files: [],
        createOnly: true,
      }),
    (err: unknown) => err instanceof VcsError && err.kind === 'branch_exists',
  );
  assert.ok(calls.every((c) => c.method === 'GET'), 'solo lecturas');
});

test('rama existente sin createOnly: commit encima y fast-forward de la ref', async () => {
  const { calls, adapter } = fakeGitHub({
    [`GET ${R}/git/ref/heads/feature/TICKET-1`]: () => ({
      status: 200,
      body: { object: { sha: 'head' } },
    }),
    [`GET ${R}/git/commits/head`]: () => ({ status: 200, body: { tree: { sha: 't' } } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: 't2' } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: 'c2' } }),
    [`PATCH ${R}/git/refs/heads/feature/TICKET-1`]: () => ({ status: 200, body: {} }),
  });

  await adapter.commitFiles({
    repo: 'marcos/sandbox',
    branch: 'feature/TICKET-1',
    base: 'main',
    message: 'm',
    files: [{ path: 'a', content: 'b' }],
    createOnly: false,
  });

  const patch = calls.find((c) => c.method === 'PATCH')!.body as Record<string, unknown>;
  assert.deepEqual(patch, { sha: 'c2', force: false }, 'nunca force-push');
});

test('la ref creada por otro entre la lectura y la escritura: branch_exists', async () => {
  const { adapter } = fakeGitHub({
    [`GET ${R}/git/ref/heads/main`]: () => ({ status: 200, body: { object: { sha: 's' } } }),
    [`GET ${R}/git/commits/s`]: () => ({ status: 200, body: { tree: { sha: 't' } } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: 't2' } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: 'c' } }),
    [`POST ${R}/git/refs`]: () => ({
      status: 422,
      body: { message: 'Reference already exists' },
    }),
  });

  await assert.rejects(
    () =>
      adapter.commitFiles({
        repo: 'marcos/sandbox',
        branch: 'x',
        base: 'main',
        message: 'm',
        files: [{ path: 'a', content: 'b' }],
        createOnly: true,
      }),
    (err: unknown) => err instanceof VcsError && err.kind === 'branch_exists',
  );
});

// ─── Errores ────────────────────────────────────────────────────────────────

test('403 al escribir: forbidden con el permiso que falta, explicito', async () => {
  const { adapter } = fakeGitHub({
    [`GET ${R}/git/ref/heads/main`]: () => ({ status: 200, body: { object: { sha: 's' } } }),
    [`GET ${R}/git/commits/s`]: () => ({ status: 200, body: { tree: { sha: 't' } } }),
    [`POST ${R}/git/trees`]: () => ({
      status: 403,
      body: { message: 'Resource not accessible by personal access token' },
    }),
  });

  await assert.rejects(
    () =>
      adapter.commitFiles({
        repo: 'marcos/sandbox',
        branch: 'x',
        base: 'main',
        message: 'm',
        files: [{ path: 'a', content: 'b' }],
        createOnly: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof VcsError);
      assert.equal(err.kind, 'forbidden');
      assert.match(err.message, /Contents: Read and write/);
      return true;
    },
  );
});

test('5xx es unavailable: reintentable', async () => {
  const { adapter } = fakeGitHub({
    [`GET ${R}`]: () => ({ status: 502, body: { message: 'Bad Gateway' } }),
  });

  await assert.rejects(
    () => adapter.checkAccess('marcos/sandbox'),
    (err: unknown) => err instanceof VcsError && err.kind === 'unavailable',
  );
});

test('checkAccess: repo inexistente o invisible para el token es not_found', async () => {
  const { adapter } = fakeGitHub({});

  await assert.rejects(
    () => adapter.checkAccess('marcos/sandbox'),
    (err: unknown) => err instanceof VcsError && err.kind === 'not_found',
  );
});

test('el token va en el header, y nunca en una URL ni en un mensaje de error', async () => {
  const { calls, adapter } = fakeGitHub({
    [`GET ${R}`]: () => ({ status: 500, body: { message: `boom ${TOKEN}` } }),
  });

  const err = await adapter.checkAccess('marcos/sandbox').catch((e: unknown) => e);

  assert.equal(calls[0]!.auth, `Bearer ${TOKEN}`);
  assert.ok(calls.every((c) => !c.path.includes(TOKEN)));
  assert.ok(err instanceof Error);
  assert.doesNotMatch(err.message, new RegExp(TOKEN), 'ni aunque GitHub lo devuelva');
});

// ─── Pull requests ──────────────────────────────────────────────────────────

test('findOpenPullRequest filtra por owner:rama y estado abierto', async () => {
  const { calls, adapter } = fakeGitHub({
    [`GET ${R}/pulls`]: () => ({
      status: 200,
      body: [{ number: 7, html_url: 'https://github.com/marcos/sandbox/pull/7' }],
    }),
  });

  const pr = await adapter.findOpenPullRequest('marcos/sandbox', 'feature/TICKET-1');

  assert.deepEqual(pr, { number: 7, url: 'https://github.com/marcos/sandbox/pull/7' });
  assert.match(calls[0]!.path, /head=marcos%3Afeature%2FTICKET-1/);
  assert.match(calls[0]!.path, /state=open/);
});

test('openPullRequest devuelve numero y url', async () => {
  const { calls, adapter } = fakeGitHub({
    [`POST ${R}/pulls`]: () => ({
      status: 201,
      body: { number: 8, html_url: 'https://github.com/marcos/sandbox/pull/8' },
    }),
  });

  const pr = await adapter.openPullRequest({
    repo: 'marcos/sandbox',
    branch: 'b',
    base: 'main',
    title: 't',
    body: 'cuerpo',
  });

  assert.equal(pr.number, 8);
  assert.deepEqual(calls[0]!.body, { title: 't', head: 'b', base: 'main', body: 'cuerpo' });
});

// ─── Checks ─────────────────────────────────────────────────────────────────

test('fetchChecks lee los check runs del HEAD del PR', async () => {
  const { calls, adapter } = fakeGitHub({
    [`GET ${R}/pulls/8`]: () => ({ status: 200, body: { head: { sha: 'head-sha' } } }),
    [`GET ${R}/commits/head-sha/check-runs`]: () => ({
      status: 200,
      body: {
        check_runs: [
          {
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            output: { title: '2 tests fallando', summary: 'Expected 401' },
          },
          { name: 'build', status: 'in_progress', conclusion: null, output: {} },
        ],
      },
    }),
  });

  const checks = await adapter.fetchChecks('marcos/sandbox', 8);

  assert.deepEqual(checks, [
    {
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      summary: '2 tests fallando: Expected 401',
    },
    { name: 'build', status: 'in_progress', conclusion: null, summary: undefined },
  ]);
  assert.ok(calls.some((c) => c.path.includes('per_page=100')));
});
