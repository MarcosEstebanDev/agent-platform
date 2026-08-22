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
  | 'DONE'
  | 'FAILED';

/**
 * Transiciones permitidas. Todo lo que no esté acá está prohibido —
 * lista blanca, no lista negra.
 *
 * En fase 2 se suman PR_OPEN / REVIEW / QA entre IN_PROGRESS y DONE.
 */
const ALLOWED: Record<TicketStatus, readonly TicketStatus[]> = {
  BACKLOG: ['ASSIGNED'],
  ASSIGNED: ['IN_PROGRESS', 'BACKLOG'],
  // FAILED vuelve a ASSIGNED para reintentar: los estados terminales
  // no son callejones sin salida.
  IN_PROGRESS: ['DONE', 'FAILED'],
  DONE: [],
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
  createdAt: Date;
  updatedAt: Date;
}
