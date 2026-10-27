import type { Ticket, TicketDelivery, TicketStatus } from '../ticket.js';
import type { AgentEvent } from '../agent-runner.js';
import type { WorkspaceExport } from './sandbox.port.js';

/**
 * Persistencia del ticket y de la traza de sus corridas.
 * El dominio no sabe que del otro lado hay Postgres.
 */

/**
 * `abandoned` lo escribe el reaper, no la corrida: es el unico outcome que
 * nadie que estuvo ahi puede reportar, justamente porque el proceso murio.
 */
export type RunOutcome =
  | 'completed'
  | 'max_iterations'
  | 'budget_exceeded'
  | 'error'
  | 'abandoned';

export interface AgentRunSummary {
  outcome: RunOutcome;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

/** Una corrida tal como se la devuelve a un cliente (API, dashboard). */
export interface AgentRunRecord {
  id: string;
  ticketId: string;
  model: string;
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  outcome: RunOutcome | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

export interface AgentEventRecord {
  seq: number;
  type: string;
  payload: unknown;
  at: Date;
}

/** Una corrida sin latido reciente: el reaper la va a cerrar. */
export interface StaleRun {
  id: string;
  ticketId: string;
}

/**
 * El trabajo que el agente dejó en el workspace, ya fuera del sandbox.
 *
 * Se guarda aparte de la corrida y no dentro de ella: el dashboard lista
 * corridas todo el tiempo, y arrastrar el contenido de los archivos en cada
 * listado convertiria una lectura barata en una cara.
 */
export interface StoredArtifact extends WorkspaceExport {
  runId: string;
  createdAt: Date;
}

export interface TicketRepositoryPort {
  create(input: { title: string; task: string }): Promise<Ticket>;
  findById(id: string): Promise<Ticket | null>;
  list(status?: TicketStatus): Promise<Ticket[]>;

  /**
   * Cambia el estado verificando que el ticket siga en `expectedFrom`.
   * Es un compare-and-set: si otro proceso lo movió mientras tanto,
   * devuelve null en vez de pisarlo.
   */
  transition(
    id: string,
    expectedFrom: TicketStatus,
    to: TicketStatus,
  ): Promise<Ticket | null>;

  /**
   * Actualiza los campos de entrega (rama, PR, gates) SIN tocar el estado.
   *
   * Va separado de `transition` a proposito: el estado cambia por
   * compare-and-set y estos campos no compiten por nada. Mezclarlos haria que
   * guardar la rama dependiera de ganar una carrera que no existe.
   */
  updateDelivery(id: string, patch: Partial<TicketDelivery>): Promise<Ticket | null>;

  /** El ticket dueño de un PR. Lo usa el webhook, que sólo conoce el número. */
  findByPullRequest(prNumber: number): Promise<Ticket | null>;

  startRun(input: { ticketId: string; model: string }): Promise<{ id: string }>;
  appendEvent(runId: string, seq: number, event: AgentEvent): Promise<void>;
  finishRun(runId: string, summary: AgentRunSummary): Promise<void>;

  /**
   * Marca que la corrida sigue viva. Lo llama el worker cada 30 s.
   *
   * Es lo unico que distingue "trabajando" de "muerto": una corrida legitima
   * puede durar mucho, asi que un timeout fijo cortaria trabajo bueno.
   */
  heartbeat(runId: string): Promise<void>;

  /** Corridas abiertas cuyo ultimo latido es anterior a `deadline`. */
  findStaleRuns(deadline: Date): Promise<StaleRun[]>;

  /**
   * De los ids dados, cuales siguen sin terminar.
   *
   * Lo usa el barrido de sandboxes huerfanos: la base es la unica fuente de
   * verdad sobre si una corrida sigue viva, asi que un worker puede decidir
   * que un container ajeno es basura sin hablar con nadie.
   */
  findOpenRunIds(runIds: string[]): Promise<string[]>;

  /**
   * Persiste el trabajo extraido del sandbox. Idempotente por runId: un
   * reintento de la extraccion pisa el resultado anterior en vez de duplicar.
   */
  saveRunArtifact(runId: string, artifact: WorkspaceExport): Promise<void>;

  getRunArtifact(runId: string): Promise<StoredArtifact | null>;

  listRuns(ticketId: string): Promise<AgentRunRecord[]>;

  /** Traza paginada por `seq`. `after` es exclusivo. */
  listEvents(
    runId: string,
    options?: { after?: number; limit?: number },
  ): Promise<AgentEventRecord[]>;
}
