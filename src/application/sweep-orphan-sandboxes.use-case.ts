import type { SandboxJanitorPort } from '../domain/ports/sandbox-janitor.port.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';

export interface SweepResult {
  /** Containers destruidos. */
  destroyed: number;
  /** Corridas a las que pertenecían. */
  runIds: string[];
}

/**
 * Destruye los containers que sobrevivieron a su worker.
 *
 * Es el complemento del reaper ([ADR 0008](../../docs/adr/0008-liveness-por-latido.md)):
 * aquel cierra la corrida en la base, éste libera la memoria de la máquina.
 * Son dos barridos independientes que se coordinan **a través de la base**,
 * sin conocerse: el reaper marca la corrida terminada, y en el barrido
 * siguiente este caso de uso ve un container cuya corrida ya cerró y lo
 * destruye.
 *
 * La pregunta "¿este container es basura?" NO se le hace a Docker, que sólo
 * sabe que el proceso sigue vivo — `sleep infinity` vive para siempre aunque
 * no haya nadie usándolo. Se le hace a la base, que es la única que sabe si
 * alguien sigue latiendo.
 */
export class SweepOrphanSandboxesUseCase {
  constructor(
    private readonly tickets: TicketRepositoryPort,
    private readonly janitor: SandboxJanitorPort,
    /**
     * Edad mínima para ser candidato.
     *
     * Existe por una carrera concreta: la corrida se marca terminada ANTES de
     * que `stop()` alcance a destruir el container. Sin gracia, un barrido que
     * caiga en esa ventana destruiría un sandbox del que su propio dueño
     * todavía se está despidiendo.
     */
    private readonly graceMs = 60_000,
  ) {}

  async execute(): Promise<SweepResult> {
    const managed = await this.janitor.listManaged();
    const candidates = managed.filter((c) => c.ageMs >= this.graceMs);
    if (candidates.length === 0) return { destroyed: 0, runIds: [] };

    const runIds = [...new Set(candidates.map((c) => c.runId))];
    const open = new Set(await this.tickets.findOpenRunIds(runIds));

    // Una corrida que la base no conoce también es huérfana: la fila pudo
    // borrarse con su ticket (onDelete: Cascade) y el container quedó igual.
    const orphans = candidates.filter((c) => !open.has(c.runId));

    for (const orphan of orphans) {
      await this.janitor.destroy(orphan.containerId);
    }

    return {
      destroyed: orphans.length,
      runIds: [...new Set(orphans.map((o) => o.runId))],
    };
  }
}
