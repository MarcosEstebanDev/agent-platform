import { Queue } from 'bullmq';
import {
  redisConnection,
  RUNS_QUEUE,
  type RunTicketJobData,
} from './infrastructure/queue/bullmq-queue.adapter.js';

/**
 * Inspector de la dead letter queue.
 *
 * En BullMQ la DLQ no es una cola aparte: es el set de jobs fallados, que se
 * conserva porque `removeOnFail` esta en false. Un job llega ahi despues de
 * agotar sus 3 intentos.
 *
 *   npm run dlq            lista los jobs muertos
 *   npm run dlq -- retry   los reencola a todos
 *   npm run dlq -- purge   los borra
 */

const connection = redisConnection(process.env.REDIS_URL ?? 'redis://localhost:6379');
const queue = new Queue<RunTicketJobData>(RUNS_QUEUE, { connection });

const accion = process.argv[2] ?? 'list';

try {
  const fallados = await queue.getFailed();

  if (fallados.length === 0) {
    console.log('DLQ vacia: ningun job agoto sus reintentos.');
  } else {
    console.log(`DLQ: ${fallados.length} job(s) muerto(s)\n`);
    for (const job of fallados) {
      const cuando = new Date(job.finishedOn ?? job.timestamp).toLocaleString('es');
      console.log(`  job ${job.id}`);
      console.log(`    ticket:    ${job.data.ticketId}`);
      console.log(`    intentos:  ${job.attemptsMade}`);
      console.log(`    cuando:    ${cuando}`);
      // trim() antes de cortar: los errores de Prisma empiezan con un salto de
      // linea, y sin esto la primera "linea" es la cadena vacia.
      const motivo = (job.failedReason ?? '').trim().split('\n')[0] ?? '(sin motivo)';
      console.log(`    motivo:    ${motivo}`);
      console.log('');
    }
  }

  if (accion === 'retry') {
    for (const job of fallados) await job.retry();
    console.log(`${fallados.length} job(s) reencolado(s).`);
  } else if (accion === 'purge') {
    for (const job of fallados) await job.remove();
    console.log(`${fallados.length} job(s) eliminado(s).`);
  } else if (accion !== 'list') {
    console.error(`Accion desconocida "${accion}". Usa: list | retry | purge`);
  }
} finally {
  await queue.close();
  await connection.quit();
}
