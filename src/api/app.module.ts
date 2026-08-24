import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { EnqueueTicketUseCase } from '../application/enqueue-ticket.use-case.js';
import type { QueuePort } from '../domain/ports/queue.port.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  createPrismaClient,
  requireDatabaseUrl,
} from '../infrastructure/persistence/prisma-client.factory.js';
import { PrismaTicketRepository } from '../infrastructure/persistence/prisma-ticket.repository.js';
import { BullMqQueueAdapter } from '../infrastructure/queue/bullmq-queue.adapter.js';
import { TicketsController } from './tickets.controller.js';
import { ENQUEUE_TICKET, PRISMA, QUEUE, TICKET_REPOSITORY } from './tokens.js';

/**
 * Composition root de la API.
 *
 * Desde la fase 1b la API NO conoce el LLM ni el sandbox: solo valida, guarda
 * y encola. Eso significa que puede arrancar sin API key y sin Docker, y que
 * un agente enroscado no puede degradarla. El trabajo pesado vive en
 * `src/worker/main.ts`, que tiene su propio composition root.
 */

/**
 * Nest sabe apagar cosas; la infraestructura no tiene por que saber que existe
 * Nest. Este wrapper es la unica pieza que conoce a los dos.
 *
 * Sin esto, el proceso no termina con Ctrl+C: la conexion a Redis mantiene
 * vivo el event loop.
 */
@Injectable()
export class QueueShutdown implements OnApplicationShutdown {
  constructor(@Inject(QUEUE) private readonly queue: QueuePort) {}

  async onApplicationShutdown(): Promise<void> {
    const closable = this.queue as { close?: () => Promise<void> };
    await closable.close?.();
  }
}

@Module({
  controllers: [TicketsController],
  providers: [
    QueueShutdown,
    {
      provide: PRISMA,
      useFactory: () => createPrismaClient(requireDatabaseUrl()),
    },
    {
      provide: QUEUE,
      useFactory: (): QueuePort =>
        new BullMqQueueAdapter(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    },
    {
      provide: TICKET_REPOSITORY,
      useFactory: (prisma: PrismaClient): TicketRepositoryPort =>
        new PrismaTicketRepository(prisma),
      inject: [PRISMA],
    },
    {
      provide: ENQUEUE_TICKET,
      useFactory: (tickets: TicketRepositoryPort, queue: QueuePort) =>
        new EnqueueTicketUseCase(tickets, queue),
      inject: [TICKET_REPOSITORY, QUEUE],
    },
  ],
})
export class AppModule {}
