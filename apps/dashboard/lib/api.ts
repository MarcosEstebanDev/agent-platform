/**
 * Cliente de la API, tipado a mano.
 *
 * Los tipos estan duplicados respecto del backend a proposito: son el contrato
 * HTTP, no las clases del dominio. Si un dia el dashboard consume otra version
 * de la API, esto cambia sin tocar el orquestador.
 */

export const API_URL = process.env.API_URL ?? 'http://localhost:3000';

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
 * Columnas del tablero. Los cuatro estados del PR van juntos en "En review":
 * nueve columnas no entran en una pantalla, y para quien mira el tablero la
 * pregunta es una sola -¿esta esperando a CI?-. El estado exacto lo dice el
 * badge de cada tarjeta.
 */
export const COLUMNS: ReadonlyArray<{ label: string; statuses: readonly TicketStatus[] }> = [
  { label: 'BACKLOG', statuses: ['BACKLOG'] },
  { label: 'ASSIGNED', statuses: ['ASSIGNED'] },
  { label: 'IN_PROGRESS', statuses: ['IN_PROGRESS'] },
  {
    label: 'EN REVIEW',
    statuses: ['PR_OPEN', 'CHECKS_RUNNING', 'CHECKS_PASSED', 'CHANGES_REQUESTED'],
  },
  { label: 'DONE', statuses: ['DONE'] },
  { label: 'FAILED', statuses: ['FAILED'] },
];

export type RunOutcome =
  | 'completed'
  | 'max_iterations'
  | 'budget_exceeded'
  | 'error'
  | 'abandoned';

export interface Ticket {
  id: string;
  title: string;
  task: string;
  status: TicketStatus;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  gateAttempts: number;
  gateFeedback: string | null;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  ticketId: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  outcome: RunOutcome | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

export interface AgentEventRecord {
  seq: number;
  type: 'text' | 'tool_call' | 'tool_result' | 'done';
  payload: Record<string, unknown>;
  at: string;
}

/**
 * La API caida es un estado normal del dashboard, no una excepcion: el
 * orquestador y el frontend son dos procesos y uno arranca antes que el otro.
 * Por eso se distingue de un error de verdad y la UI la sabe dibujar.
 */
export class ApiUnreachableError extends Error {
  constructor(readonly url: string) {
    super(`No se puede alcanzar la API en ${url}`);
    this.name = 'ApiUnreachableError';
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  } catch {
    throw new ApiUnreachableError(API_URL);
  }
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export function listTickets(status?: TicketStatus): Promise<Ticket[]> {
  return get<Ticket[]>(`/tickets${status ? `?status=${status}` : ''}`);
}

export function getTicket(id: string): Promise<Ticket> {
  return get<Ticket>(`/tickets/${id}`);
}

export function listRuns(ticketId: string): Promise<AgentRun[]> {
  return get<AgentRun[]>(`/tickets/${ticketId}/runs`);
}

export function listEvents(
  ticketId: string,
  runId: string,
  after?: number,
): Promise<AgentEventRecord[]> {
  const query = after === undefined ? '' : `?after=${after}`;
  return get<AgentEventRecord[]>(`/tickets/${ticketId}/runs/${runId}/events${query}`);
}

/** Un ticket se puede mandar a correr solo desde estos estados. */
export function isRunnable(status: TicketStatus): boolean {
  return status === 'BACKLOG' || status === 'ASSIGNED' || status === 'FAILED';
}

export function tokensOf(run: AgentRun): number {
  return run.inputTokens + run.outputTokens;
}

export function durationOf(run: AgentRun): string {
  const end = run.finishedAt ? new Date(run.finishedAt) : new Date();
  const ms = end.getTime() - new Date(run.startedAt).getTime();
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}
