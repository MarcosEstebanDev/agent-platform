import { Worker, type Job } from 'bullmq';
import { EvaluateGatesUseCase } from '../application/evaluate-gates.use-case.js';
import { OpenPullRequestUseCase } from '../application/open-pull-request.use-case.js';
import { ReapStaleRunsUseCase } from '../application/reap-stale-runs.use-case.js';
import { RunTicketUseCase } from '../application/run-ticket.use-case.js';
import { SweepOrphanSandboxesUseCase } from '../application/sweep-orphan-sandboxes.use-case.js';
import {
  buildLlm,
  buildSandboxFactory,
  readBudget,
  readExportOptions,
  readGatesConfig,
  readGitHubConfig,
  readInt,
} from '../config.js';
import { GitHubRestAdapter } from '../infrastructure/github/github-rest.adapter.js';
import {
  createPrismaClient,
  requireDatabaseUrl,
} from '../infrastructure/persistence/prisma-client.factory.js';
import { PrismaTicketRepository } from '../infrastructure/persistence/prisma-ticket.repository.js';
import { DockerSandboxJanitor } from '../infrastructure/sandbox/docker-sandbox.janitor.js';
import {
  BullMqQueueAdapter,
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
// Gracia antes de que un container sea candidato a huerfano. Cubre la ventana
// entre marcar la corrida terminada y que stop() alcance a destruirlo.
const orphanGraceMs = readInt('SANDBOX_ORPHAN_GRACE_MS') ?? 60_000;

// Respaldo del webhook (spec 004): los webhooks se pierden.
const gatesPollMs = readInt('GATES_POLL_INTERVAL_MS') ?? 60_000;

// Desde la fase 2 el agente termina en un PR. Sin GitHub configurado no hay
// donde entregar el trabajo, y correr al agente seria gastar tokens para nada.
const github = readGitHubConfig();
if (!github) {
  console.error(
    '✗ Falta GITHUB_TOKEN en .env (y GITHUB_REPO).\n' +
      '  El worker entrega cada corrida como Pull Request; sin repo destino no arranca.\n' +
      '  Ver .env.example, seccion GitHub.',
  );
  process.exit(1);
}

const prisma = createPrismaClient(requireDatabaseUrl());
const tickets = new PrismaTicketRepository(prisma);
const llm = buildLlm();
const gitHub = new GitHubRestAdapter({ token: github.token });

const delivery = new OpenPullRequestUseCase(tickets, gitHub, {
  repo: github.repo,
  base: github.base,
  secrets: [github.token],
});
const runTicket = new RunTicketUseCase(
  tickets,
  llm,
  buildSandboxFactory(),
  delivery,
  readBudget(),
  undefined,
  readExportOptions(),
);
const reaper = new ReapStaleRunsUseCase(tickets, staleAfterMs);
const janitor = new SweepOrphanSandboxesUseCase(
  tickets,
  new DockerSandboxJanitor(),
  orphanGraceMs,
);
// Cola propia para reencolar los rechazos de CI: el ciclo de correccion
// vuelve a pasar por la cola, igual que cualquier corrida.
const requeue = new BullMqQueueAdapter(redisUrl);
const gates = new EvaluateGatesUseCase(tickets, gitHub, requeue, readGatesConfig(github.repo));

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
      // Estos NO son fallas del job: el ticket no existe, se lo llevo otro
      // worker, o el repo destino es inaccesible (el ticket ya quedo FAILED
      // con el motivo). Reintentar no cambiaria nada, asi que el job termina bien.
      console.log(`  ! ${result.reason}: ${result.detail}`);
      return { skipped: result.reason };
    }

    console.log(
      `  ${result.ticket.status}  ${result.summary.iterations} iteraciones  ` +
        `${result.summary.inputTokens + result.summary.outputTokens} tokens`,
    );
    if (result.artifact.error) {
      console.warn(`  ! no se pudo rescatar el workspace: ${result.artifact.error}`);
    } else {
      console.log(
        `  ${result.artifact.files} archivo(s) rescatado(s), ` +
          `${result.artifact.bytes} bytes${result.artifact.truncated ? ' (truncado)' : ''}`,
      );
    }
    if (result.delivery?.ok) {
      console.log(`  PR #${result.delivery.pullRequest.number}: ${result.delivery.pullRequest.url}`);
    } else if (result.delivery) {
      console.warn(`  ! sin PR (${result.delivery.reason}): ${result.delivery.detail}`);
    }
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

  // Segundo barrido, independiente del primero. El reaper cierra la corrida en
  // la base; este libera la memoria de la maquina. Se coordinan a traves de la
  // base y no entre ellos: el reaper marca terminada la corrida, y en el
  // barrido siguiente el janitor ve un container cuya corrida ya cerro.
  void janitor
    .execute()
    .then(({ destroyed, runIds }) => {
      if (destroyed > 0) {
        console.warn(`[janitor] ${destroyed} sandbox(es) huerfano(s): ${runIds.join(', ')}`);
      }
    })
    .catch((err: unknown) => {
      console.error('[janitor] fallo el barrido:', err instanceof Error ? err.message : err);
    });
}, reaperIntervalMs);

// El poller de los gates vive en el worker por la misma razon que el reaper:
// la API puede tener replicas y el barrido no necesita correr N veces. Si
// igual corre dos veces, cada paso es compare-and-set y el segundo no hace nada.
const gatesPoll = setInterval(() => {
  void gates
    .evaluatePending()
    .then((results) => {
      for (const r of results) {
        if (r.outcome === 'skipped' || r.outcome === 'waiting') continue;
        const log = r.outcome === 'error' ? console.error : console.log;
        log(`[gates] ticket ${r.ticketId}: ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);
      }
    })
    .catch((err: unknown) => {
      console.error('[gates] fallo el barrido:', err instanceof Error ? err.message : err);
    });
}, gatesPollMs);

console.log(`Worker escuchando la cola "${RUNS_QUEUE}"`);
console.log(`  redis:        ${redisUrl}`);
console.log(`  modelo:       ${llm.modelName}`);
console.log(`  concurrencia: ${concurrency}`);
console.log(`  reaper:       cada ${reaperIntervalMs / 1000}s, umbral ${staleAfterMs / 1000}s`);
console.log(`  repo:         ${github.repo} (base ${github.base})`);
console.log(`  gates:        poller cada ${gatesPollMs / 1000}s\n`);

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal}: cerrando...`);
  clearInterval(sweep);
  clearInterval(gatesPoll);
  // `close()` espera a que terminen los jobs en curso. Cortar al medio dejaria
  // corridas sin cerrar, que es justamente lo que el reaper tiene que limpiar.
  await worker.close();
  await requeue.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
