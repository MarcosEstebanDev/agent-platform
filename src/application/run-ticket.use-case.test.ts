import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../domain/agent-runner.js';
import type { LlmPort, LlmResponse } from '../domain/ports/llm.port.js';
import type { SandboxFactoryPort } from '../domain/ports/sandbox-factory.port.js';
import type { ExecResult, SandboxPort } from '../domain/ports/sandbox.port.js';
import type {
  AgentRunSummary,
  TicketRepositoryPort,
} from '../domain/ports/ticket-repository.port.js';
import { assertTransition, type Ticket, type TicketStatus } from '../domain/ticket.js';
import { RunTicketUseCase } from './run-ticket.use-case.js';

/**
 * Estos tests corren sin base de datos, sin Docker y sin LLM.
 *
 * Ese es el retorno concreto de la arquitectura hexagonal: la lógica de
 * orquestación —la parte que puede corromper estado— se verifica en
 * milisegundos, contra dobles de prueba.
 */

// ─── Dobles ──────────────────────────────────────────────────────────────

class FakeTicketRepository implements TicketRepositoryPort {
  private readonly tickets = new Map<string, Ticket>();
  readonly events: Array<{ runId: string; seq: number; event: AgentEvent }> = [];
  readonly finished: Array<{ runId: string; summary: AgentRunSummary }> = [];
  private runCounter = 0;

  seed(status: TicketStatus, id = 'T-1'): Ticket {
    const ticket: Ticket = {
      id,
      title: 'test',
      task: 'hacer algo',
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  async create(input: { title: string; task: string }): Promise<Ticket> {
    return this.seed('BACKLOG', `T-${this.tickets.size + 1}`);
  }

  async findById(id: string): Promise<Ticket | null> {
    return this.tickets.get(id) ?? null;
  }

  async list(): Promise<Ticket[]> {
    return [...this.tickets.values()];
  }

  /** Mismo contrato que Postgres: compare-and-set, null si no coincide. */
  async transition(
    id: string,
    expectedFrom: TicketStatus,
    to: TicketStatus,
  ): Promise<Ticket | null> {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.status !== expectedFrom) return null;
    // El doble también respeta la máquina de estados: si el use case
    // intentara una transición ilegal, el test falla acá y no en producción.
    assertTransition(expectedFrom, to);
    const updated = { ...ticket, status: to, updatedAt: new Date() };
    this.tickets.set(id, updated);
    return updated;
  }

  async startRun(): Promise<{ id: string }> {
    return { id: `RUN-${++this.runCounter}` };
  }

  async appendEvent(runId: string, seq: number, event: AgentEvent): Promise<void> {
    this.events.push({ runId, seq, event });
  }

  async finishRun(runId: string, summary: AgentRunSummary): Promise<void> {
    this.finished.push({ runId, summary });
  }
}

class FakeLlm implements LlmPort {
  readonly modelName = 'fake-model';
  calls = 0;

  constructor(private readonly scripted: Array<LlmResponse | Error>) {}

  async complete(): Promise<LlmResponse> {
    const next = this.scripted[this.calls++] ?? textResponse('sin más guion');
    if (next instanceof Error) throw next;
    return next;
  }
}

class FakeSandbox implements SandboxPort {
  started = 0;
  stopped = 0;
  readonly commands: string[] = [];

  async start(): Promise<void> {
    this.started++;
  }
  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  }
  async writeFile(): Promise<void> {}
  async readFile(): Promise<string> {
    return '';
  }
  async stop(): Promise<void> {
    this.stopped++;
  }
}

class FakeSandboxFactory implements SandboxFactoryPort {
  readonly created: FakeSandbox[] = [];
  create(): SandboxPort {
    const sandbox = new FakeSandbox();
    this.created.push(sandbox);
    return sandbox;
  }
}

function textResponse(text: string): LlmResponse {
  return { text, toolCalls: [], stopReason: 'stop', usage: { input: 10, output: 5 } };
}

function toolResponse(command: string): LlmResponse {
  return {
    text: null,
    toolCalls: [{ id: 'call-1', name: 'bash', arguments: { command } }],
    stopReason: 'tool_calls',
    usage: { input: 20, output: 8 },
  };
}

function build(scripted: Array<LlmResponse | Error>) {
  const tickets = new FakeTicketRepository();
  const llm = new FakeLlm(scripted);
  const sandboxes = new FakeSandboxFactory();
  return {
    tickets,
    llm,
    sandboxes,
    useCase: new RunTicketUseCase(tickets, llm, sandboxes),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('camino feliz: BACKLOG termina en DONE pasando por ASSIGNED', async () => {
  const { tickets, useCase } = build([toolResponse('echo hola'), textResponse('listo')]);
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'DONE');
  assert.equal(result.summary.outcome, 'completed');
});

test('persiste la traza completa, en orden y sin huecos', async () => {
  const { tickets, useCase } = build([toolResponse('echo hola'), textResponse('listo')]);
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  const seqs = tickets.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs.keys()], 'los seq deben ser 0,1,2,... sin saltos');

  const tipos = tickets.events.map((e) => e.event.type);
  assert.ok(tipos.includes('tool_call'));
  assert.ok(tipos.includes('tool_result'));
  assert.equal(tipos.at(-1), 'done');
});

test('cierra la corrida con el resumen', async () => {
  const { tickets, useCase } = build([textResponse('listo')]);
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  assert.equal(tickets.finished.length, 1);
  assert.equal(tickets.finished[0]!.summary.outcome, 'completed');
});

test('ticket inexistente devuelve not_found sin tocar el sandbox', async () => {
  const { sandboxes, useCase } = build([]);

  const result = await useCase.execute('NO-EXISTE');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_found');
  assert.equal(sandboxes.created.length, 0, 'no debería levantar un container');
});

test('un ticket en DONE no se puede reejecutar', async () => {
  const { sandboxes, useCase } = build([]);
  const { tickets } = build([]);
  void tickets;
  const repo = new FakeTicketRepository();
  repo.seed('DONE');
  const uc = new RunTicketUseCase(repo, new FakeLlm([]), sandboxes);

  const result = await uc.execute('T-1');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid_status');
  assert.equal(sandboxes.created.length, 0);
});

test('si el LLM explota, el ticket termina en FAILED y no colgado', async () => {
  const { tickets, useCase } = build([new Error('502 del proveedor')]);
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'FAILED');
  assert.equal(result.summary.outcome, 'error');
  assert.match(result.summary.error ?? '', /502/);
});

test('el sandbox se destruye SIEMPRE, también cuando la corrida falla', async () => {
  const { tickets, sandboxes, useCase } = build([new Error('boom')]);
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  assert.equal(sandboxes.created.length, 1);
  assert.equal(sandboxes.created[0]!.stopped, 1, 'container huérfano = RAM perdida');
});

test('cada corrida usa un sandbox nuevo: un ticket no ve los archivos de otro', async () => {
  const repo = new FakeTicketRepository();
  const sandboxes = new FakeSandboxFactory();
  const uc = new RunTicketUseCase(
    repo,
    new FakeLlm([textResponse('a'), textResponse('b')]),
    sandboxes,
  );
  repo.seed('BACKLOG', 'T-1');
  repo.seed('BACKLOG', 'T-2');

  await uc.execute('T-1');
  await uc.execute('T-2');

  assert.equal(sandboxes.created.length, 2);
  assert.notEqual(sandboxes.created[0], sandboxes.created[1]);
});

test('si otro worker se adelanta, devuelve already_taken sin ejecutar nada', async () => {
  const sandboxes = new FakeSandboxFactory();
  const repo = new FakeTicketRepository();
  repo.seed('ASSIGNED');

  // Simula la carrera: el compare-and-set del claim no encuentra el estado esperado.
  const original = repo.transition.bind(repo);
  repo.transition = async (id, from, to) =>
    from === 'ASSIGNED' && to === 'IN_PROGRESS' ? null : original(id, from, to);

  const uc = new RunTicketUseCase(repo, new FakeLlm([]), sandboxes);
  const result = await uc.execute('T-1');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'already_taken');
  assert.equal(sandboxes.created.length, 0);
});

test('un fallo al persistir un evento no mata la corrida', async () => {
  const repo = new FakeTicketRepository();
  repo.seed('BACKLOG');
  repo.appendEvent = async () => {
    throw new Error('base caída');
  };

  const uc = new RunTicketUseCase(
    repo,
    new FakeLlm([textResponse('listo')]),
    new FakeSandboxFactory(),
  );
  const result = await uc.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'DONE', 'el log es best-effort, no bloqueante');
});
