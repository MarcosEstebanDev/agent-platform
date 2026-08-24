import type { Ticket, TicketStatus } from '../ticket.js';
import type { AgentEvent } from '../agent-runner.js';

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

  listRuns(ticketId: string): Promise<AgentRunRecord[]>;

  /** Traza paginada por `seq`. `after` es exclusivo. */
  listEvents(
    runId: string,
    options?: { after?: number; limit?: number },
  ): Promise<AgentEventRecord[]>;
}
