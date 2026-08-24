import {
  QueueUnavailableError,
  type QueuePort,
} from '../domain/ports/queue.port.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';

export type EnqueueTicketResult =
  | { ok: true; ticketId: string; jobId: string }
  | {
      ok: false;
      reason: 'not_found' | 'invalid_status' | 'already_taken' | 'queue_unavailable';
      detail: string;
    };

/**
 * Lo que hace la API cuando le piden ejecutar un ticket: valida, reserva y
 * encola. No ejecuta nada.
 *
 * La division con `RunTicketUseCase` no es cosmetica. Aca solo pasa lo barato
 * y determinista, para poder responder 202 en milisegundos; el trabajo caro y
 * probabilistico corre en el worker, donde puede tardar minutos y morirse sin
 * llevarse una request HTTP puesta.
 */
export class EnqueueTicketUseCase {
  constructor(
    private readonly tickets: TicketRepositoryPort,
    private readonly queue: QueuePort,
  ) {}

  async execute(ticketId: string): Promise<EnqueueTicketResult> {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) {
      return { ok: false, reason: 'not_found', detail: `No existe el ticket ${ticketId}` };
    }

    // BACKLOG -> ASSIGNED es la reserva. El claim de verdad
    // (ASSIGNED -> IN_PROGRESS) vive en el worker: si lo hicieramos aca, un
    // ticket encolado y nunca procesado quedaria IN_PROGRESS sin nadie corriendo.
    // FAILED tambien entra: es el camino de reintento. La maquina de estados
    // lo permite justamente para que un fallo -incluido el que escribe el
    // reaper cuando muere un worker- no sea un callejon sin salida.
    if (ticket.status === 'BACKLOG' || ticket.status === 'FAILED') {
      const assigned = await this.tickets.transition(ticket.id, ticket.status, 'ASSIGNED');
      if (!assigned) {
        return { ok: false, reason: 'already_taken', detail: 'Otro proceso movio el ticket' };
      }
    } else if (ticket.status !== 'ASSIGNED') {
      return {
        ok: false,
        reason: 'invalid_status',
        detail: `El ticket esta en ${ticket.status}; solo se puede encolar desde BACKLOG, ASSIGNED o FAILED`,
      };
    }

    try {
      const { jobId } = await this.queue.enqueue(ticket.id);
      return { ok: true, ticketId: ticket.id, jobId };
    } catch (err) {
      // El ticket queda en ASSIGNED, que es un estado valido y reintentable.
      // Perder el ticket porque Redis parpadeo seria mucho peor.
      if (err instanceof QueueUnavailableError) {
        return { ok: false, reason: 'queue_unavailable', detail: err.message };
      }
      throw err;
    }
  }
}
