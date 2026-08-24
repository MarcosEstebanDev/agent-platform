import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner, type AgentEvent } from './agent-runner.js';
import type { LlmPort, LlmResponse } from './ports/llm.port.js';
import type {
  ExecResult,
  SandboxPort,
  WorkspaceExport,
} from './ports/sandbox.port.js';

/**
 * Tests del loop. Dobles locales a proposito: el dominio no deberia importar
 * nada de las capas de arriba, y eso vale tambien para sus tests.
 */

class ScriptedLlm implements LlmPort {
  readonly modelName = 'scripted';
  calls = 0;
  constructor(private readonly responses: LlmResponse[]) {}
  async complete(): Promise<LlmResponse> {
    return this.responses[this.calls++] ?? tool('echo');
  }
}

class NoopSandbox implements SandboxPort {
  async start(): Promise<void> {}
  async exec(): Promise<ExecResult> {
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  }
  async writeFile(): Promise<void> {}
  async readFile(): Promise<string> {
    return '';
  }
  async exportFiles(): Promise<WorkspaceExport> {
    return { files: [], skipped: [], totalBytes: 0, truncated: false };
  }
  async stop(): Promise<void> {}
}

function tool(command: string, tokens = { input: 10, output: 5 }): LlmResponse {
  return {
    text: null,
    toolCalls: [{ id: 'c1', name: 'bash', arguments: { command } }],
    stopReason: 'tool_calls',
    usage: tokens,
  };
}

function done(text = 'listo', tokens = { input: 10, output: 5 }): LlmResponse {
  return { text, toolCalls: [], stopReason: 'stop', usage: tokens };
}

function collect(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

// ─── Presupuesto de tiempo ──────────────────────────────────────────────────

test('corta por reloj de pared antes de gastar otra llamada al proveedor', async () => {
  // Reloj falso: cada consulta avanza 1 minuto. Asi el corte por 10 minutos
  // se prueba en milisegundos y sin timers reales.
  let tick = 0;
  const clock = () => tick++ * 60_000;

  const llm = new ScriptedLlm([]);
  const { events, onEvent } = collect();

  const result = await new AgentRunner(
    llm,
    new NoopSandbox(),
    { maxWallClockMs: 5 * 60_000 },
    clock,
  ).run('tarea', onEvent);

  assert.equal(result.reason, 'budget_exceeded');
  assert.equal(result.budget, 'wall_clock');
  assert.ok(llm.calls < 25, 'deberia cortar mucho antes que por iteraciones');
  assert.deepEqual(events.at(-1), {
    type: 'done',
    reason: 'budget_exceeded',
    budget: 'wall_clock',
  });
});

test('una corrida corta no se ve afectada por el presupuesto de tiempo', async () => {
  const result = await new AgentRunner(
    new ScriptedLlm([done()]),
    new NoopSandbox(),
    { maxWallClockMs: 10 * 60_000 },
    () => 0,
  ).run('tarea', () => {});

  assert.equal(result.reason, 'completed');
});

// ─── Presupuesto de tokens ──────────────────────────────────────────────────

test('corta por tokens acumulados, no por los de una sola llamada', async () => {
  const result = await new AgentRunner(
    new ScriptedLlm([
      tool('a', { input: 300, output: 300 }),
      tool('b', { input: 300, output: 300 }),
      tool('c', { input: 300, output: 300 }),
    ]),
    new NoopSandbox(),
    { maxTokens: 1_500 },
  ).run('tarea', () => {});

  assert.equal(result.reason, 'budget_exceeded');
  assert.equal(result.budget, 'tokens');
  assert.equal(result.iterations, 3, '600 + 600 + 600 = 1800 supera 1500 en la tercera');
});

test('si el agente termina, pasarse de tokens no convierte el exito en falla', async () => {
  const result = await new AgentRunner(
    new ScriptedLlm([done('listo', { input: 5_000, output: 5_000 })]),
    new NoopSandbox(),
    { maxTokens: 100 },
  ).run('tarea', () => {});

  assert.equal(result.reason, 'completed');
});

// ─── Presupuesto de iteraciones ─────────────────────────────────────────────

test('max_iterations sigue cortando y se distingue de budget_exceeded', async () => {
  const result = await new AgentRunner(
    new ScriptedLlm([]), // siempre pide otra tool: nunca termina solo
    new NoopSandbox(),
    { maxIterations: 3 },
  ).run('tarea', () => {});

  assert.equal(result.reason, 'max_iterations');
  assert.equal(result.iterations, 3);
  assert.equal(result.budget, undefined);
});
