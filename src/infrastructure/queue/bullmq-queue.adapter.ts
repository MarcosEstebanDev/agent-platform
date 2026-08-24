import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { QueueUnavailableError, type QueuePort } from '../../domain/ports/queue.port.js';

export const RUNS_QUEUE = 'agent-runs';
export const RUN_TICKET_JOB = 'run-ticket';

export interface RunTicketJobData {
  ticketId: string;
}

/**
 * Reintentos del JOB, no del agente.
 *
 * Distinguirlos importa: un 502 del proveedor merece reintento automatico
 * (la tarea no cambio, el mundo fallo); un agente que escribio codigo que no
 * compila no. Por eso el use case devuelve FAILED sin lanzar, y solo lo que
 * lanza de verdad llega aca.
 */
const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  // Los completados se limpian; los fallados se conservan. El set de fallados
  // ES la DLQ: es lo que hay que poder inspeccionar despues.
  removeOnComplete: { count: 200 },
  removeOnFail: false,
};

/**
 * Devuelve un cliente YA CONSTRUIDO, no opciones de conexion.
 *
 * BullMQ carga 'ioredis' con un require() perezoso. Este proyecto es ESM
 * ("type": "module"), y ahi ese require falla: el propio error de BullMQ pide
 * "pass an already-constructed client instance instead of connection options".
 *
 * Efecto secundario a tener presente: una conexion que BullMQ no creo, BullMQ
 * no la cierra. Hay que hacerle quit() a mano o el proceso no termina.
 */
export function redisConnection(url: string): Redis {
  return new Redis(url, {
    // BullMQ lo exige para los workers: con reintentos acotados, un bloqueo
    // largo en Redis mataria el worker en vez de esperarlo.
    maxRetriesPerRequest: null,
  });
}

export class BullMqQueueAdapter implements QueuePort {
  private readonly queue: Queue<RunTicketJobData>;
  private readonly connection: Redis;

  constructor(redisUrl: string) {
    this.connection = redisConnection(redisUrl);
    this.queue = new Queue<RunTicketJobData>(RUNS_QUEUE, { connection: this.connection });
  }

  /**
   * `jobId = ticketId` es lo que hace la operacion idempotente: BullMQ ignora
   * un add con un id que ya existe.
   *
   * El pre-chequeo esta porque esa misma propiedad, sin mas, haria que un
   * ticket no se pueda volver a correr nunca despues de fallar: el job viejo
   * sigue ocupando el id. Un job terminado se descarta; uno pendiente o
   * corriendo se respeta.
   */
  async enqueue(ticketId: string): Promise<{ jobId: string }> {
    try {
      const existing = await this.queue.getJob(ticketId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed') {
          await existing.remove();
        } else {
          return { jobId: ticketId };
        }
      }

      await this.queue.add(RUN_TICKET_JOB, { ticketId }, { ...JOB_OPTIONS, jobId: ticketId });
      return { jobId: ticketId };
    } catch (err) {
      throw new QueueUnavailableError(err);
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
