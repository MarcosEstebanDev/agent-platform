/**
 * Puerto de limpieza de sandboxes abandonados.
 *
 * El reaper ([ADR 0008](../../../docs/adr/0008-liveness-por-latido.md)) cierra
 * la corrida en la base, pero no toca Docker: cuando un worker muere,
 * `stop()` nunca corre y el container queda vivo consumiendo memoria.
 *
 * Está separado del `SandboxPort` a propósito. Aquel representa *un* entorno
 * desde adentro de una corrida; éste mira el conjunto desde afuera, sin ser
 * dueño de ninguno.
 */

export interface ManagedSandbox {
  /** Identificador opaco para el adapter. */
  containerId: string;
  /** La corrida que lo creó, leída de su identidad. */
  runId: string;
  /** Hace cuánto existe. El barrido no toca lo recién nacido. */
  ageMs: number;
}

export interface SandboxJanitorPort {
  /** Todos los sandboxes vivos que creó esta plataforma. */
  listManaged(): Promise<ManagedSandbox[]>;

  /** Destruye uno. Seguro de llamar sobre algo que ya no existe. */
  destroy(containerId: string): Promise<void>;
}
