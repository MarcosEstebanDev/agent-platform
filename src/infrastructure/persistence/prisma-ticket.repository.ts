import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AgentEvent } from '../../domain/agent-runner.js';
import type {
  AgentRunSummary,
  TicketRepositoryPort,
} from '../../domain/ports/ticket-repository.port.js';
import type { Ticket, TicketStatus } from '../../domain/ticket.js';

export class PrismaTicketRepository implements TicketRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: { title: string; task: string }): Promise<Ticket> {
    return this.prisma.ticket.create({ data: input });
  }

  async findById(id: string): Promise<Ticket | null> {
    return this.prisma.ticket.findUnique({ where: { id } });
  }

  async list(status?: TicketStatus): Promise<Ticket[]> {
    return this.prisma.ticket.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Compare-and-set en una sola sentencia SQL: el `status` va en el WHERE,
   * así que si otro worker ya movió el ticket, el UPDATE afecta 0 filas.
   *
   * Un findById + update sería una condición de carrera: dos workers podrían
   * leer ASSIGNED al mismo tiempo y ambos creerse dueños del ticket.
   */
  async transition(
    id: string,
    expectedFrom: TicketStatus,
    to: TicketStatus,
  ): Promise<Ticket | null> {
    const { count } = await this.prisma.ticket.updateMany({
      where: { id, status: expectedFrom },
      data: { status: to },
    });
    if (count === 0) return null;
    return this.prisma.ticket.findUnique({ where: { id } });
  }

  async startRun(input: { ticketId: string; model: string }): Promise<{ id: string }> {
    const run = await this.prisma.agentRun.create({
      data: { ticketId: input.ticketId, model: input.model },
      select: { id: true },
    });
    return run;
  }

  async appendEvent(runId: string, seq: number, event: AgentEvent): Promise<void> {
    const { type, ...payload } = event;
    await this.prisma.agentEvent.create({
      data: { runId, seq, type, payload: payload as object },
    });
  }

  async finishRun(runId: string, summary: AgentRunSummary): Promise<void> {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        finishedAt: new Date(),
        outcome: summary.outcome,
        iterations: summary.iterations,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        error: summary.error ?? null,
      },
    });
  }
}
