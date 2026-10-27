import type { AgentEvent } from '../domain/agent-runner.js';
import type { LlmPort, LlmResponse } from '../domain/ports/llm.port.js';
import { QueueUnavailableError, type QueuePort } from '../domain/ports/queue.port.js';
import type {
  SandboxContext,
  SandboxFactoryPort,
} from '../domain/ports/sandbox-factory.port.js';
import type {
  ManagedSandbox,
  SandboxJanitorPort,
} from '../domain/ports/sandbox-janitor.port.js';
import type {
  ExecResult,
  ExportOptions,
  SandboxPort,
  WorkspaceExport,
  WorkspaceFile,
} from '../domain/ports/sandbox.port.js';
import type {
  AgentEventRecord,
  AgentRunRecord,
  AgentRunSummary,
  StaleRun,
  StoredArtifact,
  TicketRepositoryPort,
} from '../domain/ports/ticket-repository.port.js';
import { OpenPullRequestUseCase } from './open-pull-request.use-case.js';
import type { CheckRun, QualityGatePort } from '../domain/ports/quality-gate.port.js';
import {
  VcsError,
  type CommitFile,
  type PullRequestRef,
  type VcsPort,
} from '../domain/ports/vcs.port.js';
import {
  assertTransition,
  type Ticket,
  type TicketDelivery,
  type TicketStatus,
} from '../domain/ticket.js';

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
  readonly artifacts = new Map<string, StoredArtifact>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly runs = new Map<string, FakeRun>();
  readonly events: Array<{ runId: string; seq: number; event: AgentEvent }> = [];
  readonly finished: Array<{ runId: string; summary: AgentRunSummary }> = [];
  readonly heartbeats: string[] = [];
  private runCounter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  seed(status: TicketStatus, id = 'T-1', delivery: Partial<TicketDelivery> = {}): Ticket {
    const ticket: Ticket = {
      id,
      title: 'test',
      task: 'hacer algo',
      status,
      branch: null,
      prNumber: null,
      prUrl: null,
      gateAttempts: 0,
      gateFeedback: null,
      checksStartedAt: null,
      statusReason: null,
      ...delivery,
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

  async list(status?: TicketStatus): Promise<Ticket[]> {
    return [...this.tickets.values()].filter((t) => !status || t.status === status);
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

  async updateDelivery(id: string, patch: Partial<TicketDelivery>): Promise<Ticket | null> {
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    const updated = { ...ticket, ...patch, updatedAt: new Date(this.now()) };
    this.tickets.set(id, updated);
    return updated;
  }

  async findByPullRequest(prNumber: number): Promise<Ticket | null> {
    return [...this.tickets.values()].find((t) => t.prNumber === prNumber) ?? null;
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

  async findOpenRunIds(runIds: string[]): Promise<string[]> {
    return [...this.runs.values()]
      .filter((r) => runIds.includes(r.id) && r.finishedAt === null)
      .map((r) => r.id);
  }

  async saveRunArtifact(runId: string, artifact: WorkspaceExport): Promise<void> {
    // Igual que el repo real: upsert por runId, no acumulacion.
    this.artifacts.set(runId, {
      ...artifact,
      runId,
      createdAt: new Date(this.now()),
    });
  }

  async getRunArtifact(runId: string): Promise<StoredArtifact | null> {
    return this.artifacts.get(runId) ?? null;
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

  /**
   * Lo que "escribio el agente". El test lo configura antes de correr.
   *
   * Arranca con un archivo y no vacio: desde la fase 2, una corrida sin
   * artefacto no puede abrir PR, y los tests del ciclo de vida asumen un
   * agente que hizo algo.
   */
  files: WorkspaceFile[] = [{ path: 'out.txt', content: 'ok', bytes: 2 }];
  /** Para probar que un rescate fallido no tumba la corrida. */
  exportFails?: Error;
  /** Cuantos archivos habia cuando se exporto: prueba el orden extraer->apagar. */
  filesAtExport: number | null = null;
  /** Estado del sandbox al momento de exportar. */
  stoppedAtExport: number | null = null;

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

  async exportFiles(_options?: ExportOptions): Promise<WorkspaceExport> {
    // El contrato real: exportar sobre un sandbox no iniciado es un error.
    if (this.started === 0) throw new Error('El sandbox no esta iniciado.');
    this.filesAtExport = this.files.length;
    this.stoppedAtExport = this.stopped;
    if (this.exportFails) throw this.exportFails;
    return {
      files: this.files,
      skipped: [],
      totalBytes: this.files.reduce((sum, f) => sum + f.bytes, 0),
      truncated: false,
    };
  }

  async stop(): Promise<void> {
    this.stopped++;
  }
}

export class FakeSandboxFactory implements SandboxFactoryPort {
  readonly created: FakeSandbox[] = [];
  readonly contexts: SandboxContext[] = [];
  /** Se aplica a cada sandbox creado, para preparar el escenario del test. */
  constructor(private readonly prepare?: (sandbox: FakeSandbox) => void) {}

  create(context: SandboxContext): SandboxPort {
    const sandbox = new FakeSandbox();
    this.prepare?.(sandbox);
    this.created.push(sandbox);
    this.contexts.push(context);
    return sandbox;
  }
}

export class FakeSandboxJanitor implements SandboxJanitorPort {
  readonly destroyed: string[] = [];
  constructor(private managed: ManagedSandbox[] = []) {}

  setManaged(managed: ManagedSandbox[]): void {
    this.managed = managed;
  }

  async listManaged(): Promise<ManagedSandbox[]> {
    return this.managed;
  }

  async destroy(containerId: string): Promise<void> {
    this.destroyed.push(containerId);
    this.managed = this.managed.filter((c) => c.containerId !== containerId);
  }
}

/**
 * GitHub de mentira, con el mismo contrato que el adapter real: las ramas
 * existen o no, `createOnly` sobre una existente lanza `branch_exists`, y abrir
 * un PR dos veces sobre la misma rama es un error (GitHub devuelve 422).
 */
export class FakeVcs implements VcsPort {
  /** rama -> commits, en orden. */
  readonly branches = new Map<string, Array<{ message: string; files: CommitFile[] }>>();
  readonly pullRequests: Array<PullRequestRef & { branch: string; title: string; body: string }> =
    [];
  readonly accessChecks: string[] = [];
  private prCounter = 0;

  /** Falla programada por operacion, para probar cada modo de falla. */
  failAccess?: VcsError;
  failCommit?: VcsError;
  failOpenPr?: VcsError;

  /** Simula ramas que ya existen en el repo y no son nuestras. */
  seedBranch(branch: string): void {
    this.branches.set(branch, [{ message: 'ajeno', files: [] }]);
  }

  async checkAccess(repo: string): Promise<void> {
    this.accessChecks.push(repo);
    if (this.failAccess) throw this.failAccess;
  }

  async commitFiles(input: {
    repo: string;
    branch: string;
    base: string;
    message: string;
    files: CommitFile[];
    createOnly: boolean;
  }): Promise<{ sha: string }> {
    if (this.failCommit) throw this.failCommit;
    const existing = this.branches.get(input.branch);
    if (existing && input.createOnly) {
      throw new VcsError('branch_exists', `La rama ${input.branch} ya existe`);
    }
    const commits = existing ?? [];
    commits.push({ message: input.message, files: input.files });
    this.branches.set(input.branch, commits);
    return { sha: `sha-${input.branch}-${commits.length}` };
  }

  async findOpenPullRequest(_repo: string, branch: string): Promise<PullRequestRef | null> {
    const pr = this.pullRequests.find((p) => p.branch === branch);
    return pr ? { number: pr.number, url: pr.url } : null;
  }

  async openPullRequest(input: {
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    if (this.failOpenPr) throw this.failOpenPr;
    if (this.pullRequests.some((p) => p.branch === input.branch)) {
      throw new VcsError('unavailable', `Ya hay un PR abierto desde ${input.branch}`);
    }
    const number = ++this.prCounter + 40;
    const pr = { number, url: `https://github.test/pr/${number}` };
    this.pullRequests.push({ ...pr, branch: input.branch, title: input.title, body: input.body });
    return pr;
  }
}

/** CI de mentira: el test decide que checks devuelve cada PR. */
export class FakeQualityGate implements QualityGatePort {
  readonly checks = new Map<number, CheckRun[]>();
  readonly fetched: number[] = [];
  fail?: Error;

  set(prNumber: number, checks: CheckRun[]): void {
    this.checks.set(prNumber, checks);
  }

  async fetchChecks(_repo: string, prNumber: number): Promise<CheckRun[]> {
    this.fetched.push(prNumber);
    if (this.fail) throw this.fail;
    return this.checks.get(prNumber) ?? [];
  }
}

/** El flujo de PR completo contra GitHub de mentira, listo para inyectar. */
export function deliveryFor(
  tickets: TicketRepositoryPort,
  vcs: VcsPort = new FakeVcs(),
): OpenPullRequestUseCase {
  return new OpenPullRequestUseCase(tickets, vcs, { repo: 'marcos/sandbox', base: 'main' });
}

export function green(name: string): CheckRun {
  return { name, status: 'completed', conclusion: 'success' };
}

export function red(name: string, summary?: string): CheckRun {
  return { name, status: 'completed', conclusion: 'failure', summary };
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
