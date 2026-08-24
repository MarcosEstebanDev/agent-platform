import {
  AgentRunner,
  DEFAULT_BUDGET,
  type AgentBudget,
  type AgentEvent,
} from '../domain/agent-runner.js';
import type { LlmPort } from '../domain/ports/llm.port.js';
import type { SandboxFactoryPort } from '../domain/ports/sandbox-factory.port.js';
import type { ExportOptions, SandboxPort } from '../domain/ports/sandbox.port.js';
import type {
  AgentRunSummary,
  TicketRepositoryPort,
} from '../domain/ports/ticket-repository.port.js';
import type { Ticket } from '../domain/ticket.js';

/** Qué sobrevivió al sandbox. Se informa aunque la extracción haya fallado. */
export interface ArtifactOutcome {
  files: number;
  bytes: number;
  truncated: boolean;
  error?: string;
}

export type RunTicketResult =
  | {
      ok: true;
      ticket: Ticket;
      runId: string;
      summary: AgentRunSummary;
      artifact: ArtifactOutcome;
    }
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
    /** Techos de la extraccion. Ver SandboxPort.exportFiles. */
    private readonly exportOptions: ExportOptions = {},
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

    // El sandbox lleva el id de la corrida: es lo que despues permite saber,
    // mirando solo Docker y la base, si un container que sobrevivio a su
    // worker es basura o alguien trabajando.
    const sandbox = this.sandboxes.create({ runId: run.id });
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
    let artifact: ArtifactOutcome = { files: 0, bytes: 0, truncated: false };
    // Sin start() no hay nada que extraer, y exportFiles tiraria un error
    // que taparia el motivo real de la falla.
    let started = false;

    try {
      await sandbox.start();
      started = true;

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
      // ORDEN CRITICO: extraer, despues apagar. `stop()` es irreversible, y
      // lo que el agente escribio solo existe dentro del container.
      if (started) {
        artifact = await this.rescue(sandbox, run.id, persist);
      }
      // El latido se corta DESPUES de la extraccion: sacar un workspace
      // grande lleva su tiempo, y dejar de latir mientras tanto haria que el
      // reaper diera por muerta una corrida que esta terminando bien.
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
      artifact,
    };
  }

  /**
   * Saca el trabajo del sandbox y lo persiste.
   *
   * No puede tumbar la corrida: si el agente resolvio la tarea, que falle el
   * rescate no invalida lo que hizo. Pero tampoco se calla — el error queda
   * en la traza, porque un PR vacio sin explicacion es peor que uno que dice
   * por que esta vacio.
   *
   * Cuando la fase 2 abra Pull Requests esto cambia de peso: sin artefacto no
   * hay PR posible, y ahi el que decide que hacer es el flujo del PR, no este
   * metodo.
   */
  private async rescue(
    sandbox: SandboxPort,
    runId: string,
    persist: (event: AgentEvent) => Promise<void>,
  ): Promise<ArtifactOutcome> {
    try {
      const exported = await sandbox.exportFiles(this.exportOptions);
      await this.tickets.saveRunArtifact(runId, exported);

      const outcome: ArtifactOutcome = {
        files: exported.files.length,
        bytes: exported.totalBytes,
        truncated: exported.truncated,
      };
      await persist({ type: 'artifact', ...outcome });
      return outcome;
    } catch (err) {
      const outcome: ArtifactOutcome = {
        files: 0,
        bytes: 0,
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      };
      await persist({ type: 'artifact', ...outcome });
      return outcome;
    }
  }
}
