import type { AgentBudget } from './domain/agent-runner.js';
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
