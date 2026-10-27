import type { GatesConfig } from './application/evaluate-gates.use-case.js';
import type { AgentBudget } from './domain/agent-runner.js';
import type { ExportOptions } from './domain/ports/sandbox.port.js';
import { OpenAiCompatibleAdapter } from './infrastructure/llm/openai-compatible.adapter.js';
import { DockerSandboxFactory } from './infrastructure/sandbox/docker-sandbox.factory.js';

/**
 * Lectura de configuracion, en un solo lugar.
 *
 * La API y el worker son dos procesos distintos con dos composition roots
 * distintos, pero tienen que interpretar el mismo `.env` igual. Duplicar el
 * parseo es como se llega a que el worker use un modelo y la API reporte otro.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} en el entorno (.env)`);
  return value;
}

export function buildLlm(): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    baseUrl: requireEnv('LLM_BASE_URL'),
    apiKey: requireEnv('LLM_API_KEY'),
    model: process.env.LLM_MODEL ?? 'openai/gpt-oss-120b',
  });
}

export function buildSandboxFactory(): DockerSandboxFactory {
  return new DockerSandboxFactory({
    image: process.env.SANDBOX_IMAGE,
    // Cualquier valor que no sea exactamente 'bridge' cae en 'none'. El
    // default inseguro nunca se activa por un typo.
    network: process.env.SANDBOX_NETWORK === 'bridge' ? 'bridge' : 'none',
  });
}

/**
 * Techos de la extraccion del workspace.
 *
 * Mismo criterio que `readBudget`: solo las claves configuradas, para no
 * pisar los defaults del adapter con `undefined`.
 */
export function readExportOptions(): ExportOptions {
  const options: ExportOptions = {};

  const maxFileBytes = readInt('EXPORT_MAX_FILE_BYTES');
  if (maxFileBytes !== undefined) options.maxFileBytes = maxFileBytes;

  const maxTotalBytes = readInt('EXPORT_MAX_TOTAL_BYTES');
  if (maxTotalBytes !== undefined) options.maxTotalBytes = maxTotalBytes;

  const exclude = process.env.EXPORT_EXCLUDE;
  if (exclude?.trim()) {
    options.exclude = exclude.split(',').map((s) => s.trim()).filter(Boolean);
  }

  return options;
}

/**
 * Solo incluye las claves realmente configuradas.
 *
 * No es cosmetico: el runner hace `{ ...DEFAULT_BUDGET, ...budget }`, y una
 * clave presente con valor `undefined` PISA el default. Devolver
 * `{ maxTokens: undefined }` desactivaria el limite de tokens en silencio.
 */
export function readBudget(): Partial<AgentBudget> {
  const budget: Partial<AgentBudget> = {};

  const maxIterations = readInt('BUDGET_MAX_ITERATIONS');
  if (maxIterations !== undefined) budget.maxIterations = maxIterations;

  const maxWallClockMs = readInt('BUDGET_MAX_WALL_CLOCK_MS');
  if (maxWallClockMs !== undefined) budget.maxWallClockMs = maxWallClockMs;

  const maxTokens = readInt('BUDGET_MAX_TOKENS');
  if (maxTokens !== undefined) budget.maxTokens = maxTokens;

  return budget;
}

export function readInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} debe ser un numero positivo, no "${raw}"`);
  }
  return value;
}

// ─── GitHub: PRs (fase 2) y gates (fase 3) ──────────────────────────────────

export interface GitHubConfig {
  token: string;
  /** `owner/nombre` */
  repo: string;
  base: string;
  /** Sin secreto el webhook queda deshabilitado; el poller cubre igual. */
  webhookSecret?: string;
}

/**
 * null si no hay token: la API puede arrancar igual (sus rutas de GitHub
 * responden 503). El worker, en cambio, lo exige: sin GitHub no hay donde
 * entregar el trabajo, y correr al agente seria gastar tokens para nada.
 */
export function readGitHubConfig(): GitHubConfig | null {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token || token === 'PEGA_TU_PAT_ACA') return null;

  const repo = requireEnv('GITHUB_REPO').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`GITHUB_REPO debe tener la forma owner/nombre, no "${repo}"`);
  }
  return {
    token,
    repo,
    base: process.env.GITHUB_BASE_BRANCH?.trim() || 'main',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET?.trim() || undefined,
  };
}

/** Mismo criterio que `readBudget`: solo lo configurado, sin pisar defaults. */
export function readGatesConfig(repo: string): GatesConfig {
  const config: GatesConfig = { repo };

  const timeoutMs = readInt('GATES_TIMEOUT_MS');
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  const maxAttempts = readInt('GATES_MAX_ATTEMPTS');
  if (maxAttempts !== undefined) config.maxAttempts = maxAttempts;

  const nonBlocking = process.env.GATES_NON_BLOCKING;
  if (nonBlocking?.trim()) {
    config.nonBlocking = nonBlocking.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return config;
}
