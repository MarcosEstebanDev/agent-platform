/**
 * Puerto de cola de trabajo.
 *
 * El dominio no sabe que del otro lado hay BullMQ y Redis. Le alcanza con
 * saber que encolar un ticket es idempotente y que puede fallar.
 */

export class QueueUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `La cola no responde: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'QueueUnavailableError';
  }
}

export interface QueuePort {
  /**
   * Encola una corrida para el ticket.
   *
   * DEBE ser idempotente por ticket: encolar dos veces el mismo ticket
   * mientras el primero sigue pendiente produce una sola corrida.
   *
   * Lanza `QueueUnavailableError` si no se puede hablar con la cola.
   */
  enqueue(ticketId: string): Promise<{ jobId: string }>;
}
