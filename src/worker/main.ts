import { Worker, type Job } from 'bullmq';
import { ReapStaleRunsUseCase } from '../application/reap-stale-runs.use-case.js';
import { RunTicketUseCase } from '../application/run-ticket.use-case.js';
import { buildLlm, buildSandboxFactory, readBudget, readInt } from '../config.js';
import {
  createPrismaClient,
  requireDatabaseUrl,
} from '../infrastructure/persistence/prisma-client.factory.js';
import { PrismaTicketRepository } from '../infrastructure/persistence/prisma-ticket.repository.js';
import {
  redisConnection,
  RUNS_QUEUE,
  type RunTicketJobData,
} from '../infrastructure/queue/bullmq-queue.adapter.js';

/**
 * El worker. Composition root del proceso que hace el trabajo pesado.
 *
 * Corre aparte de la API a proposito: una corrida puede tardar minutos y
 * morirse. Que eso pase en un proceso que ademas atiende HTTP significa que
 * un agente enroscado degrada la API entera.
 */

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const concurrency = readInt('WORKER_CONCURRENCY') ?? 2;
// El peor caso de deteccion es (umbral + intervalo), no el umbral solo: una
// corrida puede volverse rancia justo despues de un barrido. Con 90s + 30s da
// 2 min exactos, que es el limite que promete la spec 002. Un intervalo de
// 5 min con umbral de 2 daria 7 min y el criterio seria imposible de cumplir.
const reaperIntervalMs = readInt('REAPER_INTERVAL_MS') ?? 30_000;
// 90s = tres latidos perdidos. Menos que eso arriesga matar corridas vivas.
const staleAfterMs = readInt('REAPER_STALE_AFTER_MS') ?? 90_000;

const prisma = createPrismaClient(requireDatabaseUrl());
const tickets = new PrismaTicketRepository(prisma);
const llm = buildLlm();

const runTicket = new RunTicketUseCase(tickets, llm, buildSandboxFactory(), readBudget());
const reaper = new ReapStaleRunsUseCase(tickets, staleAfterMs);

// La conexion se construye aca y se cierra aca: BullMQ no cierra las que no creo.
const connection = redisConnection(redisUrl);

const worker = new Worker<RunTicketJobData>(
  RUNS_QUEUE,
  async (job: Job<RunTicketJobData>) => {
    const { ticketId } = job.data;
    console.log(`\n[job ${job.id}] ticket ${ticketId} - intento ${job.attemptsMade + 1}`);

    const result = await runTicket.execute(ticketId, (event) => {
      if (event.type === 'tool_call') console.log(`  > ${event.name}`);
      if (event.type === 'done') console.log(`  = ${event.reason}`);
    });

    if (!result.ok) {
      // Estos NO son fallas del job: el ticket no existe, o se lo llevo otro
      // worker. Reintentar no cambiaria nada, asi que el job termina bien.
      console.log(`  ! ${result.reason}: ${result.detail}`);
      return { skipped: result.reason };
    }

    console.log(
      `  ${result.ticket.status}  ${result.summary.iterations} iteraciones  ` +
        `${result.summary.inputTokens + result.summary.outputTokens} tokens`,
    );
    return { status: result.ticket.status, runId: result.runId };
  },
  { connection, concurrency },
);

worker.on('failed', (job, err) => {
  console.error(`[job ${job?.id}] fallo: ${err.message}`);
});

// El reaper vive en el worker y no en la API porque la API puede correr con
// varias replicas detras de un balanceador; el barrido no necesita correr N
// veces. Con varios workers el trabajo igual es idempotente: el segundo no
// encuentra corridas abiertas que cerrar.
const sweep = setInterval(() => {
  void reaper
    .execute()
    .then(({ reaped, ticketIds }) => {
      if (reaped > 0) {
        console.warn(`[reaper] ${reaped} corrida(s) abandonada(s): ${ticketIds.join(', ')}`);
      }
    })
    .catch((err: unknown) => {
      console.error('[reaper] fallo el barrido:', err instanceof Error ? err.message : err);
    });
}, reaperIntervalMs);

console.log(`Worker escuchando la cola "${RUNS_QUEUE}"`);
console.log(`  redis:        ${redisUrl}`);
console.log(`  modelo:       ${llm.modelName}`);
console.log(`  concurrencia: ${concurrency}`);
console.log(`  reaper:       cada ${reaperIntervalMs / 1000}s, umbral ${staleAfterMs / 1000}s\n`);

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal}: cerrando...`);
  clearInterval(sweep);
  // `close()` espera a que terminen los jobs en curso. Cortar al medio dejaria
  // corridas sin cerrar, que es justamente lo que el reaper tiene que limpiar.
  await worker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
