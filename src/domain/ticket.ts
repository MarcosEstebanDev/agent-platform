/**
 * Máquina de estados del ticket. Dominio puro: sin Prisma, sin Nest, sin I/O.
 *
 * Es el corazón de la plataforma. El agente propone; esto dispone.
 * Ninguna transición ocurre porque el modelo diga que terminó: ocurre porque
 * el orquestador la autorizó desde acá.
 */

export type TicketStatus =
  | 'BACKLOG'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'PR_OPEN'
  | 'CHECKS_RUNNING'
  | 'CHECKS_PASSED'
  | 'CHANGES_REQUESTED'
  | 'DONE'
  | 'FAILED';

/**
 * Transiciones permitidas. Todo lo que no esté acá está prohibido —
 * lista blanca, no lista negra.
 *
 * Desde la fase 3, IN_PROGRESS ya no lleva a DONE. El agente termina en un PR
 * (PR_OPEN), y a DONE sólo se llega por CHECKS_PASSED, que escribe la
 * evaluación de los checks de CI y nunca el agente (ADR 0007).
 */
const ALLOWED: Record<TicketStatus, readonly TicketStatus[]> = {
  BACKLOG: ['ASSIGNED'],
  ASSIGNED: ['IN_PROGRESS', 'BACKLOG'],
  IN_PROGRESS: ['PR_OPEN', 'FAILED'],
  // PR_OPEN espera una señal externa. FAILED cubre el PR que no se puede
  // evaluar (cerrado a mano, repo borrado).
  PR_OPEN: ['CHECKS_RUNNING', 'FAILED'],
  CHECKS_RUNNING: ['CHECKS_PASSED', 'CHANGES_REQUESTED', 'FAILED'],
  CHECKS_PASSED: ['DONE'],
  // El ciclo de corrección: vuelve a ASSIGNED con el feedback de los checks,
  // o a FAILED cuando se agotan los intentos.
  CHANGES_REQUESTED: ['ASSIGNED', 'FAILED'],
  DONE: [],
  // FAILED vuelve a ASSIGNED para reintentar: los estados terminales
  // no son callejones sin salida.
  FAILED: ['ASSIGNED'],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TicketStatus,
    readonly to: TicketStatus,
  ) {
    super(
      `Transición inválida ${from} → ${to}. ` +
        `Desde ${from} sólo se puede ir a: ${ALLOWED[from].join(', ') || '(ninguno)'}`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Lanza si la transición no está permitida. Usar antes de persistir. */
export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: TicketStatus): boolean {
  return ALLOWED[status].length === 0;
}

export interface Ticket {
  id: string;
  title: string;
  /** La instrucción que recibe el agente. */
  task: string;
  status: TicketStatus;

  // ─── Entrega (fases 2 y 3) ───────────────────────────────────────────────
  /** Rama donde vive el trabajo. Se guarda apenas se pushea, antes del PR. */
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** Cuántas veces los checks rechazaron el PR. Tope en la spec 004: 3. */
  gateAttempts: number;
  /** Lo que falló en el último intento. Se suma al task del reintento. */
  gateFeedback: string | null;
  /** Desde cuándo se esperan los checks. Mide el timeout de 30 min. */
  checksStartedAt: Date | null;
  /**
   * Por qué el ticket está donde está, cuando no es obvio: el scope que le
   * falta al token, `gates_exhausted`, un PR que no se pudo abrir.
   */
  statusReason: string | null;

  createdAt: Date;
  updatedAt: Date;
}

/** Los campos de entrega, que se actualizan sin tocar el estado. */
export type TicketDelivery = Pick<
  Ticket,
  | 'branch'
  | 'prNumber'
  | 'prUrl'
  | 'gateAttempts'
  | 'gateFeedback'
  | 'checksStartedAt'
  | 'statusReason'
>;

/**
 * Lo que recibe el agente: el task original más, si hubo un intento anterior
 * rechazado, lo que falló.
 *
 * El feedback se guarda aparte y se compone acá, en vez de reescribir `task`:
 * reescribirlo apilaría el feedback de cada intento sobre el anterior, y el
 * task original se perdería.
 */
export function composeTask(task: string, gateFeedback: string | null): string {
  if (!gateFeedback) return task;
  return `${task}\n\n---\n${gateFeedback}`;
}
