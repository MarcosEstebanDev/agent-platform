import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AgentEvent } from '../../domain/agent-runner.js';
import type {
  AgentEventRecord,
  AgentRunRecord,
  AgentRunSummary,
  RunOutcome,
  StaleRun,
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

  /**
   * El primer latido se escribe al crear la corrida, no al primer tick del
   * intervalo. Si no, una corrida que muere en los primeros 30 s queda con
   * `heartbeat_at` en NULL y el reaper no la ve.
   */
  async startRun(input: { ticketId: string; model: string }): Promise<{ id: string }> {
    const run = await this.prisma.agentRun.create({
      data: { ticketId: input.ticketId, model: input.model, heartbeatAt: new Date() },
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

  /**
   * `updateMany` con `finishedAt: null` en el WHERE, no `update`: si el reaper
   * y el worker llegan a la vez, el segundo no pisa el resultado del primero.
   * Una corrida se cierra una sola vez.
   */
  async finishRun(runId: string, summary: AgentRunSummary): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, finishedAt: null },
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

  async heartbeat(runId: string): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, finishedAt: null },
      data: { heartbeatAt: new Date() },
    });
  }

  async findStaleRuns(deadline: Date): Promise<StaleRun[]> {
    return this.prisma.agentRun.findMany({
      where: {
        finishedAt: null,
        // El OR cubre las corridas anteriores a esta migracion, que pueden
        // tener heartbeat_at en NULL: se juzgan por su fecha de inicio.
        OR: [
          { heartbeatAt: { lt: deadline } },
          { heartbeatAt: null, startedAt: { lt: deadline } },
        ],
      },
      select: { id: true, ticketId: true },
    });
  }

  async listRuns(ticketId: string): Promise<AgentRunRecord[]> {
    const runs = await this.prisma.agentRun.findMany({
      where: { ticketId },
      orderBy: { startedAt: 'desc' },
    });
    return runs.map((r) => ({ ...r, outcome: r.outcome as RunOutcome | null }));
  }

  async listEvents(
    runId: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<AgentEventRecord[]> {
    // Techo duro: la traza de una corrida larga son cientos de eventos y
    // algunos traen archivos enteros en el payload.
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    return this.prisma.agentEvent.findMany({
      where: { runId, ...(options.after !== undefined && { seq: { gt: options.after } }) },
      orderBy: { seq: 'asc' },
      take: limit,
      select: { seq: true, type: true, payload: true, at: true },
    });
  }
}
