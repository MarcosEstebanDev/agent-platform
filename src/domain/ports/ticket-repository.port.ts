import type { Ticket, TicketStatus } from '../ticket.js';
import type { AgentEvent } from '../agent-runner.js';

/**
 * Persistencia del ticket y de la traza de sus corridas.
 * El dominio no sabe que del otro lado hay Postgres.
 */

export interface AgentRunSummary {
  outcome: 'completed' | 'max_iterations' | 'error';
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
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
}
