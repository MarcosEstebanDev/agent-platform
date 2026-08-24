import {
  AgentRunner,
  DEFAULT_BUDGET,
  type AgentBudget,
  type AgentEvent,
} from '../domain/agent-runner.js';
import type { LlmPort } from '../domain/ports/llm.port.js';
import type { SandboxFactoryPort } from '../domain/ports/sandbox-factory.port.js';
import type {
  AgentRunSummary,
  TicketRepositoryPort,
} from '../domain/ports/ticket-repository.port.js';
import type { Ticket } from '../domain/ticket.js';

export type RunTicketResult =
  | { ok: true; ticket: Ticket; runId: string; summary: AgentRunSummary }
  | { ok: false; reason: 'not_found' | 'already_taken' | 'invalid_status'; detail: string };

/**
 * Ejecuta un ticket de punta a punta y deja traza de todo.
 *
 * El orden importa: el ticket pasa a IN_PROGRESS ANTES de arrancar el agente
 * y la corrida se cierra SIEMPRE, aunque el agente explote. Un ticket colgado
 * en IN_PROGRESS para siempre es peor que uno fallado.
 */
export class RunTicketUseCase {
  constructor(
    private readonly tickets: TicketRepositoryPort,
    private readonly llm: LlmPort,
    private readonly sandboxes: SandboxFactoryPort,
    private readonly budget: Partial<AgentBudget> = {},
    /** Cada cuanto se reporta el latido. Menos de la mitad del umbral del reaper. */
    private readonly heartbeatMs = 30_000,
  ) {}

  async execute(
    ticketId: string,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<RunTicketResult> {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) {
      return { ok: false, reason: 'not_found', detail: `No existe el ticket ${ticketId}` };
    }

    // BACKLOG necesita pasar por ASSIGNED: la máquina de estados no permite
    // saltear, y el use case no es quién para hacer una excepción.
    let current = ticket;
    if (current.status === 'BACKLOG') {
      const assigned = await this.tickets.transition(current.id, 'BACKLOG', 'ASSIGNED');
      if (!assigned) {
        return { ok: false, reason: 'already_taken', detail: 'Otro proceso movió el ticket' };
      }
      current = assigned;
    }

    if (current.status !== 'ASSIGNED') {
      return {
        ok: false,
        reason: 'invalid_status',
        detail: `El ticket está en ${current.status}; sólo se puede ejecutar desde BACKLOG o ASSIGNED`,
      };
    }

    // Compare-and-set: si dos workers agarran el mismo ticket, sólo uno gana.
    const claimed = await this.tickets.transition(current.id, 'ASSIGNED', 'IN_PROGRESS');
    if (!claimed) {
      return { ok: false, reason: 'already_taken', detail: 'Otro worker tomó el ticket' };
    }

    const run = await this.tickets.startRun({
      ticketId: claimed.id,
      model: this.llm.modelName,
    });

    const sandbox = this.sandboxes.create();
    let seq = 0;

    // Persistir el evento no debe poder matar la corrida: si falla el log,
    // el trabajo del agente sigue siendo válido.
    const persist = async (event: AgentEvent): Promise<void> => {
      onEvent?.(event);
      try {
        await this.tickets.appendEvent(run.id, seq++, event);
      } catch {
        /* el log de auditoría es best-effort */
      }
    };

    // Latido. Mientras esto siga escribiendo, el reaper no toca la corrida.
    //
    // Es un intervalo y no un tick por evento a proposito: un solo comando
    // puede tardar minutos sin emitir nada, y ese silencio no significa que
    // el worker haya muerto.
    const beat = setInterval(() => {
      void this.tickets.heartbeat(run.id).catch(() => {
        /* si falla un latido, el siguiente lo corrige */
      });
    }, this.heartbeatMs);
    beat.unref();

    // El reloj del presupuesto arranca ACA, no dentro del loop del agente.
    // Levantar el container puede tardar segundos (y bajarse una imagen,
    // minutos): si no contaran, "10 minutos de presupuesto" seria en realidad
    // "10 minutos mas lo que tarde Docker", que no es un techo de nada.
    const runStartedAt = Date.now();

    let summary: AgentRunSummary;
    try {
      await sandbox.start();

      const techo = this.budget.maxWallClockMs ?? DEFAULT_BUDGET.maxWallClockMs;
      const restante = Math.max(techo - (Date.now() - runStartedAt), 0);

      const result = await new AgentRunner(this.llm, sandbox, {
        ...this.budget,
        maxWallClockMs: restante,
      }).run(claimed.task, (event) => void persist(event));
      summary = {
        outcome: result.reason,
        iterations: result.iterations,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        // Cortar por presupuesto no es un fallo del agente, pero sin dejar
        // constancia del motivo el FAILED queda inexplicable en el dashboard.
        error: result.budget ? `presupuesto agotado: ${result.budget}` : undefined,
      };
    } catch (err) {
      summary = {
        outcome: 'error',
        iterations: 0,
        inputTokens: 0,
        outputTokens: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearInterval(beat);
      await sandbox.stop();
    }

    await this.tickets.finishRun(run.id, summary);

    // FASE 1: el veredicto sale del autoreporte del agente.
    // FASE 3: sale de los checks del PR, y esta línea cambia.
    const finalStatus = summary.outcome === 'completed' ? 'DONE' : 'FAILED';
    const finished = await this.tickets.transition(claimed.id, 'IN_PROGRESS', finalStatus);

    return {
      ok: true,
      ticket: finished ?? { ...claimed, status: finalStatus },
      runId: run.id,
      summary,
    };
  }
}
