import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { RunTicketUseCase } from '../application/run-ticket.use-case.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';
import type { TicketStatus } from '../domain/ticket.js';
import { RUN_TICKET, TICKET_REPOSITORY } from './tokens.js';

const STATUSES: readonly TicketStatus[] = [
  'BACKLOG',
  'ASSIGNED',
  'IN_PROGRESS',
  'DONE',
  'FAILED',
];

@Controller('tickets')
export class TicketsController {
  constructor(
    @Inject(TICKET_REPOSITORY) private readonly tickets: TicketRepositoryPort,
    @Inject(RUN_TICKET) private readonly runTicket: RunTicketUseCase,
  ) {}

  @Post()
  async create(@Body() body: { title?: unknown; task?: unknown }) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const task = typeof body?.task === 'string' ? body.task.trim() : '';
    if (!title || !task) {
      throw new BadRequestException('Se requieren "title" y "task" no vacíos');
    }
    return this.tickets.create({ title, task });
  }

  @Get()
  async list(@Query('status') status?: string) {
    if (status && !STATUSES.includes(status as TicketStatus)) {
      throw new BadRequestException(`status inválido. Válidos: ${STATUSES.join(', ')}`);
    }
    return this.tickets.list(status as TicketStatus | undefined);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const ticket = await this.tickets.findById(id);
    if (!ticket) throw new NotFoundException(`No existe el ticket ${id}`);
    return ticket;
  }

  /**
   * Ejecuta el ticket de forma SÍNCRONA: la request queda abierta hasta que
   * el agente termina. Es aceptable en fase 1 con tareas cortas.
   *
   * FASE 1b: esto encola un job en BullMQ y devuelve 202 con el runId.
   * Una corrida real puede tardar minutos y ningún cliente HTTP debería
   * quedarse esperando eso.
   */
  @Post(':id/run')
  async run(@Param('id') id: string) {
    const result = await this.runTicket.execute(id);

    if (!result.ok) {
      if (result.reason === 'not_found') throw new NotFoundException(result.detail);
      throw new ConflictException(result.detail);
    }

    return {
      ticket: result.ticket,
      runId: result.runId,
      summary: result.summary,
    };
  }
}
