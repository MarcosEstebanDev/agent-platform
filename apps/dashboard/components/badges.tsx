import type { RunOutcome, TicketStatus } from '@/lib/api';

type Tone = 'ok' | 'err' | 'warn' | 'run' | 'idle';

const STATUS_TONE: Record<TicketStatus, Tone> = {
  BACKLOG: 'idle',
  ASSIGNED: 'warn',
  IN_PROGRESS: 'run',
  PR_OPEN: 'run',
  CHECKS_RUNNING: 'run',
  CHECKS_PASSED: 'ok',
  // warn y no err: el ciclo de correccion es el sistema funcionando, no roto.
  CHANGES_REQUESTED: 'warn',
  DONE: 'ok',
  FAILED: 'err',
};

/**
 * `max_iterations` y `budget_exceeded` son warn, no err: la corrida no se
 * rompio, la corto el orquestador. Pintarlas de rojo haria pensar que hay un
 * bug donde hubo una decision.
 */
const OUTCOME_TONE: Record<RunOutcome, Tone> = {
  completed: 'ok',
  max_iterations: 'warn',
  budget_exceeded: 'warn',
  error: 'err',
  abandoned: 'err',
};

const OUTCOME_LABEL: Record<RunOutcome, string> = {
  completed: 'completada',
  max_iterations: 'corte por iteraciones',
  budget_exceeded: 'presupuesto agotado',
  error: 'error',
  abandoned: 'abandonada',
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className="badge" data-tone={STATUS_TONE[status]}>
      {status}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: RunOutcome | null }) {
  if (!outcome) {
    return (
      <span className="badge" data-tone="run">
        en curso
      </span>
    );
  }
  return (
    <span className="badge" data-tone={OUTCOME_TONE[outcome]}>
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}
