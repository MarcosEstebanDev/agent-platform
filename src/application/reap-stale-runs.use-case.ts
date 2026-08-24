import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';

export interface ReapResult {
  /** Corridas cerradas como 'abandoned'. */
  reaped: number;
  ticketIds: string[];
}

/**
 * El reaper: cierra las corridas que dejaron de latir.
 *
 * Existe porque sin el hay un estado inconsistente permanente. Si el worker
 * muere a mitad de corrida, el ticket queda en IN_PROGRESS y nadie lo vuelve
 * a mirar nunca: no esta en la cola, no esta en BACKLOG, no fallo. Simplemente
 * desaparece.
 *
 * Un timeout fijo no serviria: una corrida legitima puede durar mucho. Lo que
 * distingue "trabajando" de "muerto" es si alguien sigue reportando.
 */
export class ReapStaleRunsUseCase {
  constructor(
    private readonly tickets: TicketRepositoryPort,
    /**
     * Cuanto silencio se tolera antes de dar una corrida por muerta.
     * 90s son tres latidos perdidos (el worker late cada 30s).
     */
    private readonly staleAfterMs = 90_000,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(): Promise<ReapResult> {
    const deadline = new Date(this.now() - this.staleAfterMs);
    const stale = await this.tickets.findStaleRuns(deadline);

    const ticketIds: string[] = [];

    for (const run of stale) {
      // Primero se cierra la corrida y despues se mueve el ticket. En ese
      // orden: si el proceso muere en el medio, queda una corrida cerrada y un
      // ticket que el proximo barrido no encuentra (ya no hay corrida abierta)
      // pero que sigue siendo visible como IN_PROGRESS. Al reves quedaria un
      // ticket FAILED con una corrida abierta latiendo para siempre.
      await this.tickets.finishRun(run.id, {
        outcome: 'abandoned',
        iterations: 0,
        inputTokens: 0,
        outputTokens: 0,
        error: `Sin latido desde hace mas de ${Math.round(this.staleAfterMs / 1000)}s: el worker murio`,
      });

      // FAILED y no ASSIGNED: reencolar solo un ticket que quizas se murio por
      // ser toxico es como se construye un loop infinito caro. Desde FAILED un
      // humano (o una politica) decide reintentar.
      const moved = await this.tickets.transition(run.ticketId, 'IN_PROGRESS', 'FAILED');
      if (moved) ticketIds.push(run.ticketId);
    }

    return { reaped: stale.length, ticketIds };
  }
}
