import type { AgentEvent } from '../domain/agent-runner.js';
import type { LlmPort, LlmResponse } from '../domain/ports/llm.port.js';
import { QueueUnavailableError, type QueuePort } from '../domain/ports/queue.port.js';
import type { SandboxFactoryPort } from '../domain/ports/sandbox-factory.port.js';
import type { ExecResult, SandboxPort } from '../domain/ports/sandbox.port.js';
import type {
  AgentEventRecord,
  AgentRunRecord,
  AgentRunSummary,
  StaleRun,
  TicketRepositoryPort,
} from '../domain/ports/ticket-repository.port.js';
import { assertTransition, type Ticket, type TicketStatus } from '../domain/ticket.js';

/**
 * Dobles de prueba compartidos.
 *
 * No es un archivo de tests: es lo que hace que los tests corran sin base,
 * sin Docker, sin Redis y sin LLM. Cada doble replica el CONTRATO del puerto
 * real, no una version conveniente de el -- si el doble es mas permisivo que
 * Postgres, los tests pasan y produccion rompe.
 */

interface FakeRun {
  id: string;
  ticketId: string;
  model: string;
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  summary: AgentRunSummary | null;
}

export class FakeTicketRepository implements TicketRepositoryPort {
  private readonly tickets = new Map<string, Ticket>();
  private readonly runs = new Map<string, FakeRun>();
  readonly events: Array<{ runId: string; seq: number; event: AgentEvent }> = [];
  readonly finished: Array<{ runId: string; summary: AgentRunSummary }> = [];
  readonly heartbeats: string[] = [];
  private runCounter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  seed(status: TicketStatus, id = 'T-1'): Ticket {
    const ticket: Ticket = {
      id,
      title: 'test',
      task: 'hacer algo',
      status,
      createdAt: new Date(this.now()),
      updatedAt: new Date(this.now()),
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  /** Corrida abierta con un latido en el pasado, para probar el reaper. */
  seedRun(ticketId: string, heartbeatAgoMs: number, id = `RUN-${++this.runCounter}`): FakeRun {
    const run: FakeRun = {
      id,
      ticketId,
      model: 'fake-model',
      startedAt: new Date(this.now() - heartbeatAgoMs),
      finishedAt: null,
      heartbeatAt: new Date(this.now() - heartbeatAgoMs),
      summary: null,
    };
    this.runs.set(id, run);
    return run;
  }

  async create(input: { title: string; task: string }): Promise<Ticket> {
    const ticket = this.seed('BACKLOG', `T-${this.tickets.size + 1}`);
    return { ...ticket, title: input.title, task: input.task };
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
    // El doble tambien respeta la maquina de estados: si el use case
    // intentara una transicion ilegal, el test falla aca y no en produccion.
    assertTransition(expectedFrom, to);
    const updated = { ...ticket, status: to, updatedAt: new Date(this.now()) };
    this.tickets.set(id, updated);
    return updated;
  }

  async startRun(input: { ticketId: string; model: string }): Promise<{ id: string }> {
    const id = `RUN-${++this.runCounter}`;
    this.runs.set(id, {
      id,
      ticketId: input.ticketId,
      model: input.model,
      startedAt: new Date(this.now()),
      finishedAt: null,
      heartbeatAt: new Date(this.now()),
      summary: null,
    });
    return { id };
  }

  async appendEvent(runId: string, seq: number, event: AgentEvent): Promise<void> {
    this.events.push({ runId, seq, event });
  }

  /** Como el repo real: una corrida se cierra una sola vez. */
  async finishRun(runId: string, summary: AgentRunSummary): Promise<void> {
    const run = this.runs.get(runId);
    if (run && run.finishedAt) return;
    if (run) {
      run.finishedAt = new Date(this.now());
      run.summary = summary;
    }
    this.finished.push({ runId, summary });
  }

  async heartbeat(runId: string): Promise<void> {
    this.heartbeats.push(runId);
    const run = this.runs.get(runId);
    if (run && !run.finishedAt) run.heartbeatAt = new Date(this.now());
  }

  async findStaleRuns(deadline: Date): Promise<StaleRun[]> {
    return [...this.runs.values()]
      .filter((r) => !r.finishedAt)
      .filter((r) => (r.heartbeatAt ?? r.startedAt).getTime() < deadline.getTime())
      .map((r) => ({ id: r.id, ticketId: r.ticketId }));
  }

  async listRuns(ticketId: string): Promise<AgentRunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.ticketId === ticketId)
      .map((r) => ({
        id: r.id,
        ticketId: r.ticketId,
        model: r.model,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        heartbeatAt: r.heartbeatAt,
        outcome: r.summary?.outcome ?? null,
        iterations: r.summary?.iterations ?? 0,
        inputTokens: r.summary?.inputTokens ?? 0,
        outputTokens: r.summary?.outputTokens ?? 0,
        error: r.summary?.error ?? null,
      }));
  }

  async listEvents(
    runId: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<AgentEventRecord[]> {
    return this.events
      .filter((e) => e.runId === runId)
      .filter((e) => options.after === undefined || e.seq > options.after)
      .slice(0, options.limit ?? 200)
      .map(({ seq, event }) => {
        // Igual que el repo real: `type` es columna, no parte del payload.
        const { type, ...payload } = event;
        return { seq, type, payload, at: new Date(this.now()) };
      });
  }
}

export class FakeQueue implements QueuePort {
  readonly enqueued: string[] = [];
  available = true;

  async enqueue(ticketId: string): Promise<{ jobId: string }> {
    if (!this.available) throw new QueueUnavailableError(new Error('redis caido'));
    // Idempotente por ticket, igual que el adapter real con jobId = ticketId.
    if (!this.enqueued.includes(ticketId)) this.enqueued.push(ticketId);
    return { jobId: ticketId };
  }
}

export class FakeLlm implements LlmPort {
  readonly modelName = 'fake-model';
  calls = 0;

  constructor(private readonly scripted: Array<LlmResponse | Error> = []) {}

  async complete(): Promise<LlmResponse> {
    const next = this.scripted[this.calls++] ?? textResponse('sin mas guion');
    if (next instanceof Error) throw next;
    return next;
  }
}

export class FakeSandbox implements SandboxPort {
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

export class FakeSandboxFactory implements SandboxFactoryPort {
  readonly created: FakeSandbox[] = [];
  create(): SandboxPort {
    const sandbox = new FakeSandbox();
    this.created.push(sandbox);
    return sandbox;
  }
}

export function textResponse(text: string, tokens = { input: 10, output: 5 }): LlmResponse {
  return { text, toolCalls: [], stopReason: 'stop', usage: tokens };
}

export function toolResponse(
  command: string,
  tokens = { input: 20, output: 8 },
): LlmResponse {
  return {
    text: null,
    toolCalls: [{ id: 'call-1', name: 'bash', arguments: { command } }],
    stopReason: 'tool_calls',
    usage: tokens,
  };
}
