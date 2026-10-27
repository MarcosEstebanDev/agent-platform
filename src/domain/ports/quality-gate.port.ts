/**
 * Puerto de gates de calidad: lo que CI dice sobre un Pull Request.
 *
 * Devuelve los checks CRUDOS, no un veredicto. La regla que decide si un PR
 * pasa vive en el dominio (`evaluateChecks`), no en el adapter: si cada
 * adapter interpretara "verde" a su manera, el criterio de DONE dependeria de
 * contra que proveedor de CI se corre (ver ADR 0013).
 *
 * SonarCloud no tiene adapter propio: publica su quality gate como un check
 * mas sobre el commit, asi que llega por aca igual que GitHub Actions.
 */

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale';

export interface CheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  /** null mientras el check no termino. */
  conclusion: CheckConclusion | null;
  /** Resumen que el check publico, si publico alguno. Va al feedback. */
  summary?: string;
}

export interface QualityGatePort {
  /** Los checks del commit HEAD del PR. */
  fetchChecks(repo: string, prNumber: number): Promise<CheckRun[]>;
}
