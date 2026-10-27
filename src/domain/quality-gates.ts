import type { CheckRun } from './ports/quality-gate.port.js';

/**
 * La regla que decide si un PR pasa los gates. Dominio puro.
 *
 * Es el veredicto que ADR 0007 le saca al agente: lo que dice CI sobre un
 * commit que el agente no puede escribir.
 */

export type GateState = 'pending' | 'passed' | 'failed';

export interface GateVerdict {
  state: GateState;
  /** Checks bloqueantes en rojo. Son los que van al feedback del reintento. */
  failed: CheckRun[];
  /** Checks no bloqueantes en rojo: se informan, no frenan. */
  warnings: CheckRun[];
}

export interface GatePolicy {
  /**
   * Nombres de checks que no bloquean (spec 004: los de SonarCloud se pueden
   * marcar como advertencia mientras se calibra el proyecto).
   */
  nonBlocking?: readonly string[];
}

const RED: ReadonlySet<string> = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
]);

function isRed(check: CheckRun): boolean {
  return check.status === 'completed' && check.conclusion !== null && RED.has(check.conclusion);
}

export function evaluateChecks(checks: CheckRun[], policy: GatePolicy = {}): GateVerdict {
  const nonBlocking = new Set(policy.nonBlocking ?? []);
  const blocking = checks.filter((c) => !nonBlocking.has(c.name));
  const warnings = checks.filter((c) => nonBlocking.has(c.name) && isRed(c));

  // Un rojo decide aunque haya checks corriendo: el PR ya no puede pasar, y
  // esperar al resto es tiempo que el agente no esta corrigiendo.
  const failed = blocking.filter(isRed);
  if (failed.length > 0) return { state: 'failed', failed, warnings };

  const running = blocking.some((c) => c.status !== 'completed');
  // "Ningun DONE sin al menos un check verde" (spec 004). Sin esto, un repo
  // sin CI -o un PR cuyo CI todavia no arranco- pasaria por vacio: cero
  // checks, cero rojos.
  const green = blocking.some((c) => c.conclusion === 'success');

  if (running || !green) return { state: 'pending', failed: [], warnings };
  return { state: 'passed', failed: [], warnings };
}

/** El motivo cuando no hubo un check en rojo sino silencio. */
export type GateFailureCause = 'checks_failed' | 'checks_timeout';

const MAX_SUMMARY = 300;

/**
 * Lo que se le dice al agente en el reintento.
 *
 * Va al prompt, no es un log: los resumenes se recortan. Un stack trace de
 * cinco mil caracteres no ayuda al agente mas que las primeras lineas, y si
 * cuesta tokens en cada iteracion del loop.
 */
export function formatGateFeedback(
  prNumber: number,
  checks: CheckRun[],
  cause: GateFailureCause = 'checks_failed',
): string {
  const lines = [
    cause === 'checks_timeout'
      ? `Intento anterior (PR #${prNumber}) falló: checks_timeout — CI no respondió a tiempo.`
      : `Intento anterior (PR #${prNumber}) falló:`,
  ];

  for (const c of checks) {
    const mark = isRed(c) ? '✗' : c.status !== 'completed' ? '…' : '✓';
    const summary = c.summary?.trim();
    lines.push(
      summary && isRed(c)
        ? `  ${mark} ${c.name} — ${truncate(summary.replace(/\s+/g, ' '), MAX_SUMMARY)}`
        : `  ${mark} ${c.name}`,
    );
  }

  lines.push('', 'Corregí la causa. No modifiques los tests para hacerlos pasar.');
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
