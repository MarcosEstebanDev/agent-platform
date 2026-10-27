import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { EnqueueTicketUseCase } from '../application/enqueue-ticket.use-case.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';
import type { TicketStatus } from '../domain/ticket.js';
import { ENQUEUE_TICKET, TICKET_REPOSITORY } from './tokens.js';

const STATUSES: readonly TicketStatus[] = [
  'BACKLOG',
  'ASSIGNED',
  'IN_PROGRESS',
  'PR_OPEN',
  'CHECKS_RUNNING',
  'CHECKS_PASSED',
  'CHANGES_REQUESTED',
  'DONE',
  'FAILED',
];

@Controller('tickets')
export class TicketsController {
  constructor(
    @Inject(TICKET_REPOSITORY) private readonly tickets: TicketRepositoryPort,
    @Inject(ENQUEUE_TICKET) private readonly enqueueTicket: EnqueueTicketUseCase,
  ) {}

  @Post()
  async create(@Body() body: { title?: unknown; task?: unknown }) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const task = typeof body?.task === 'string' ? body.task.trim() : '';
    if (!title || !task) {
      throw new BadRequestException('Se requieren "title" y "task" no vacios');
    }
    return this.tickets.create({ title, task });
  }

  @Get()
  async list(@Query('status') status?: string) {
    if (status && !STATUSES.includes(status as TicketStatus)) {
      throw new BadRequestException(`status invalido. Validos: ${STATUSES.join(', ')}`);
    }
    return this.tickets.list(status as TicketStatus | undefined);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.requireTicket(id);
  }

  /**
   * Encola la corrida y devuelve 202. NO ejecuta nada.
   *
   * Antes esto era sincrono y la request quedaba abierta minutos: cualquier
   * proxy la cortaba y el cliente no tenia forma de saber si el trabajo seguia.
   * Ahora el progreso se sigue por GET /tickets/:id/runs.
   */
  @Post(':id/run')
  @HttpCode(202)
  async run(@Param('id') id: string) {
    const result = await this.enqueueTicket.execute(id);

    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          throw new NotFoundException(result.detail);
        // El ticket sigue en un estado valido y reintentable: lo unico caido
        // es la cola. 503 le dice al cliente "volve a intentar", no "no sirve".
        case 'queue_unavailable':
          throw new ServiceUnavailableException(result.detail);
        default:
          throw new ConflictException(result.detail);
      }
    }

    return { ticketId: result.ticketId, jobId: result.jobId, status: 'QUEUED' };
  }

  @Get(':id/runs')
  async runs(@Param('id') id: string) {
    await this.requireTicket(id);
    return this.tickets.listRuns(id);
  }

  /** Traza de una corrida. `after` es el ultimo `seq` que el cliente ya vio. */
  @Get(':id/runs/:runId/events')
  async events(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    await this.requireRun(id, runId);

    return this.tickets.listEvents(runId, {
      after: parsePositiveInt(after, 'after'),
      limit: parsePositiveInt(limit, 'limit'),
    });
  }

  /**
   * El trabajo que sobrevivio al sandbox.
   *
   * Va aparte de `/runs` y no embebido en el: el listado de corridas lo pide
   * el tablero todo el tiempo, y arrastrar el contenido de los archivos en
   * cada refresco convierte la lectura mas frecuente en la mas cara.
   */
  @Get(':id/runs/:runId/artifact')
  async artifact(@Param('id') id: string, @Param('runId') runId: string) {
    await this.requireRun(id, runId);

    const artifact = await this.tickets.getRunArtifact(runId);
    if (!artifact) {
      throw new NotFoundException(
        `La corrida ${runId} no tiene trabajo rescatado. ` +
          'O no llego a arrancar el sandbox, o la extraccion fallo (mira la traza).',
      );
    }
    return artifact;
  }

  private async requireTicket(id: string) {
    const ticket = await this.tickets.findById(id);
    if (!ticket) throw new NotFoundException(`No existe el ticket ${id}`);
    return ticket;
  }

  /**
   * La corrida existe Y pertenece al ticket de la ruta.
   *
   * Sin la segunda mitad, /tickets/A/runs/<run-de-B>/events devolveria la
   * traza de B: la ruta anidada tiene que significar lo que promete.
   */
  private async requireRun(ticketId: string, runId: string) {
    await this.requireTicket(ticketId);
    const runs = await this.tickets.listRuns(ticketId);
    if (!runs.some((r) => r.id === runId)) {
      throw new NotFoundException(`La corrida ${runId} no pertenece al ticket ${ticketId}`);
    }
  }
}

function parsePositiveInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`"${field}" debe ser un entero >= 0`);
  }
  return value;
}
