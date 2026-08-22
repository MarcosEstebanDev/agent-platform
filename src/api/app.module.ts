import { Module } from '@nestjs/common';
import { RunTicketUseCase } from '../application/run-ticket.use-case.js';
import type { LlmPort } from '../domain/ports/llm.port.js';
import type { SandboxFactoryPort } from '../domain/ports/sandbox-factory.port.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { OpenAiCompatibleAdapter } from '../infrastructure/llm/openai-compatible.adapter.js';
import {
  createPrismaClient,
  requireDatabaseUrl,
} from '../infrastructure/persistence/prisma-client.factory.js';
import { PrismaTicketRepository } from '../infrastructure/persistence/prisma-ticket.repository.js';
import { DockerSandboxFactory } from '../infrastructure/sandbox/docker-sandbox.factory.js';
import { TicketsController } from './tickets.controller.js';
import {
  LLM,
  PRISMA,
  RUN_TICKET,
  SANDBOX_FACTORY,
  TICKET_REPOSITORY,
} from './tokens.js';

/**
 * Composition root de la API.
 *
 * Es el único lugar donde se nombran los adapters concretos. Todo lo de
 * arriba (controller) y lo de abajo (dominio, casos de uso) sólo conoce
 * puertos. Cambiar de proveedor de LLM o de sandbox se hace acá.
 */
@Module({
  controllers: [TicketsController],
  providers: [
    {
      provide: PRISMA,
      useFactory: () => createPrismaClient(requireDatabaseUrl()),
    },
    {
      provide: LLM,
      useFactory: (): LlmPort => {
        const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
        if (!LLM_BASE_URL || !LLM_API_KEY) {
          throw new Error('Faltan LLM_BASE_URL / LLM_API_KEY en .env');
        }
        return new OpenAiCompatibleAdapter({
          baseUrl: LLM_BASE_URL,
          apiKey: LLM_API_KEY,
          model: LLM_MODEL ?? 'openai/gpt-oss-120b',
        });
      },
    },
    {
      provide: SANDBOX_FACTORY,
      useFactory: (): SandboxFactoryPort =>
        new DockerSandboxFactory({
          image: process.env.SANDBOX_IMAGE,
          network: process.env.SANDBOX_NETWORK === 'bridge' ? 'bridge' : 'none',
        }),
    },
    {
      provide: TICKET_REPOSITORY,
      useFactory: (prisma: PrismaClient): TicketRepositoryPort =>
        new PrismaTicketRepository(prisma),
      inject: [PRISMA],
    },
    {
      provide: RUN_TICKET,
      useFactory: (
        tickets: TicketRepositoryPort,
        llm: LlmPort,
        sandboxes: SandboxFactoryPort,
      ) => new RunTicketUseCase(tickets, llm, sandboxes),
      inject: [TICKET_REPOSITORY, LLM, SANDBOX_FACTORY],
    },
  ],
})
export class AppModule {}
