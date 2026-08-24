import type { SandboxPort } from './sandbox.port.js';

/**
 * A qué corrida pertenece el sandbox.
 *
 * No es metadato decorativo: el adapter de Docker lo escribe como label del
 * container, y eso es lo único que después permite distinguir un container
 * huérfano —cuyo worker murió— de uno que está trabajando. Sin esta identidad,
 * limpiar huérfanos sería adivinar (ver ADR 0011).
 */
export interface SandboxContext {
  runId: string;
}

/**
 * Cada corrida necesita un sandbox limpio: un ticket no debe ver los
 * archivos que dejó otro. Por eso se inyecta una fábrica, no una instancia.
 */
export interface SandboxFactoryPort {
  create(context: SandboxContext): SandboxPort;
}
