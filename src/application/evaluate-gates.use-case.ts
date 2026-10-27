import {
  evaluateChecks,
  formatGateFeedback,
  type GateFailureCause,
} from '../domain/quality-gates.js';
import type { CheckRun, QualityGatePort } from '../domain/ports/quality-gate.port.js';
import { QueueUnavailableError, type QueuePort } from '../domain/ports/queue.port.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';
import type { Ticket } from '../domain/ticket.js';

export interface GatesConfig {
  repo: string;
  /** Spec 004: 30 min sin respuesta de CI cuenta como rechazo. */
  timeoutMs?: number;
  /** Spec 004: al tercer rechazo, FAILED y que mire un humano. */
  maxAttempts?: number;
  /** Checks que avisan pero no bloquean (los de SonarCloud, mientras se calibra). */
  nonBlocking?: readonly string[];
}

/**
 * - `skipped`: el ticket no estaba esperando checks (o lo movio otro proceso).
 * - `waiting`: CI sigue corriendo.
 * - `requeued` / `changes_requested`: rechazo; el agente reintenta. El segundo
 *   es "con la cola caida": el ticket quedo ASSIGNED y hay que reencolarlo.
 * - `error`: no se pudo consultar CI. Solo lo devuelve `evaluatePending`.
 */
export type GateOutcome =
  | 'skipped'
  | 'waiting'
  | 'done'
  | 'requeued'
  | 'changes_requested'
  | 'gates_exhausted'
  | 'error';

export interface EvaluateGatesResult {
  ticketId: string;
  outcome: GateOutcome;
  detail?: string;
}

const AWAITING_CHECKS = ['PR_OPEN', 'CHECKS_RUNNING'] as const;

/**
 * El veredicto de un ticket. Lo dispara el webhook de GitHub o el poller.
 *
 * Es la otra mitad de ADR 0007: el agente abrio un PR, y lo que decide si el
 * trabajo esta hecho es lo que CI reporta sobre ese PR, que el agente no
 * puede escribir.
 *
 * Webhook y poller pueden llegar a la vez, y desde procesos distintos (API y
 * worker). No hace falta coordinarlos: cada paso es un compare-and-set, y el
 * que llega segundo encuentra el ticket en otro estado y no hace nada.
 */
export class EvaluateGatesUseCase {
  constructor(
    private readonly tickets: TicketRepositoryPort,
    private readonly gates: QualityGatePort,
    private readonly queue: QueuePort,
    private readonly config: GatesConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(ticketId: string): Promise<EvaluateGatesResult> {
    let ticket = await this.tickets.findById(ticketId);
    if (!ticket || !isAwaitingChecks(ticket)) return { ticketId, outcome: 'skipped' };

    if (ticket.prNumber === null) {
      // No deberia pasar: PR_OPEN se escribe despues de guardar el numero. Si
      // pasa, esperar no lo arregla.
      await this.tickets.updateDelivery(ticket.id, { statusReason: 'PR_OPEN sin numero de PR' });
      await this.tickets.transition(ticket.id, ticket.status, 'FAILED');
      return { ticketId, outcome: 'skipped', detail: 'sin numero de PR' };
    }

    if (ticket.status === 'PR_OPEN') {
      // El reloj del timeout arranca cuando se empieza a esperar a CI.
      await this.tickets.updateDelivery(ticket.id, { checksStartedAt: new Date(this.now()) });
      const running = await this.tickets.transition(ticket.id, 'PR_OPEN', 'CHECKS_RUNNING');
      if (!running) return { ticketId, outcome: 'skipped' };
      ticket = running;
    }

    const checks = await this.gates.fetchChecks(this.config.repo, ticket.prNumber!);
    const verdict = evaluateChecks(checks, { nonBlocking: this.config.nonBlocking });

    switch (verdict.state) {
      case 'passed': {
        const passed = await this.tickets.transition(ticket.id, 'CHECKS_RUNNING', 'CHECKS_PASSED');
        if (!passed) return { ticketId, outcome: 'skipped' };
        await this.tickets.updateDelivery(ticket.id, {
          statusReason:
            verdict.warnings.length > 0
              ? `Advertencias: ${verdict.warnings.map((c) => c.name).join(', ')}`
              : null,
        });
        await this.tickets.transition(ticket.id, 'CHECKS_PASSED', 'DONE');
        return { ticketId, outcome: 'done' };
      }

      case 'failed':
        return this.reject(ticket, checks, 'checks_failed');

      case 'pending': {
        const startedAt = ticket.checksStartedAt?.getTime() ?? this.now();
        if (this.now() - startedAt >= (this.config.timeoutMs ?? 30 * 60_000)) {
          return this.reject(ticket, checks, 'checks_timeout');
        }
        return { ticketId, outcome: 'waiting' };
      }
    }
  }

  /**
   * El barrido del poller: todos los tickets que esperan checks.
   *
   * No es redundancia decorativa (spec 004): los webhooks se pierden. Sin
   * esto, un ticket cuyo webhook no llego espera para siempre.
   *
   * Un PR que falla al consultarse no corta el barrido: se informa y se sigue
   * con el resto.
   */
  async evaluatePending(): Promise<EvaluateGatesResult[]> {
    const waiting = (
      await Promise.all(AWAITING_CHECKS.map((status) => this.tickets.list(status)))
    ).flat();

    const results: EvaluateGatesResult[] = [];
    for (const ticket of waiting) {
      try {
        results.push(await this.execute(ticket.id));
      } catch (err) {
        results.push({
          ticketId: ticket.id,
          outcome: 'error',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  private async reject(
    ticket: Ticket,
    checks: CheckRun[],
    cause: GateFailureCause,
  ): Promise<EvaluateGatesResult> {
    const ticketId = ticket.id;
    const rejected = await this.tickets.transition(ticketId, 'CHECKS_RUNNING', 'CHANGES_REQUESTED');
    if (!rejected) return { ticketId, outcome: 'skipped' };

    const attempts = ticket.gateAttempts + 1;
    await this.tickets.updateDelivery(ticketId, {
      gateAttempts: attempts,
      gateFeedback: formatGateFeedback(ticket.prNumber!, checks, cause),
      checksStartedAt: null,
      statusReason: cause,
    });

    // Un agente que no pasa el gate en tres intentos no lo va a lograr en el
    // cuarto: lo que hace es quemar tokens.
    if (attempts >= (this.config.maxAttempts ?? 3)) {
      await this.tickets.updateDelivery(ticketId, { statusReason: 'gates_exhausted' });
      await this.tickets.transition(ticketId, 'CHANGES_REQUESTED', 'FAILED');
      return { ticketId, outcome: 'gates_exhausted' };
    }

    await this.tickets.transition(ticketId, 'CHANGES_REQUESTED', 'ASSIGNED');
    try {
      await this.queue.enqueue(ticketId);
      return { ticketId, outcome: 'requeued' };
    } catch (err) {
      // ASSIGNED es un estado valido y reintentable: perder el ticket porque
      // Redis parpadeo seria mucho peor que reencolarlo a mano.
      if (err instanceof QueueUnavailableError) {
        return { ticketId, outcome: 'changes_requested', detail: err.message };
      }
      throw err;
    }
  }
}

function isAwaitingChecks(ticket: Ticket): boolean {
  return (AWAITING_CHECKS as readonly string[]).includes(ticket.status);
}
