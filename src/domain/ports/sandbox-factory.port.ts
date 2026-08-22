import type { SandboxPort } from './sandbox.port.js';

/**
 * Cada corrida necesita un sandbox limpio: un ticket no debe ver los
 * archivos que dejó otro. Por eso se inyecta una fábrica, no una instancia.
 */
export interface SandboxFactoryPort {
  create(): SandboxPort;
}
