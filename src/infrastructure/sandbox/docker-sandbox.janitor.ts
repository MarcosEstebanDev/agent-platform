import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ManagedSandbox,
  SandboxJanitorPort,
} from '../../domain/ports/sandbox-janitor.port.js';
import { RUN_LABEL } from './docker.sandbox.js';

const run = promisify(execFile);

/**
 * Encuentra y destruye containers que sobrevivieron a su worker.
 *
 * Sólo mira containers con el label de la plataforma, así que no puede tocar
 * nada ajeno: si alguien corre otro Docker en la misma máquina, es invisible
 * para este barrido.
 *
 * No decide por su cuenta qué es huérfano — sólo informa qué existe. Quién
 * está vivo lo dice la base, y esa decisión vive en el caso de uso.
 */
export class DockerSandboxJanitor implements SandboxJanitorPort {
  async listManaged(): Promise<ManagedSandbox[]> {
    let ids: string[];
    try {
      const { stdout } = await run(
        'docker',
        ['ps', '-a', '--filter', `label=${RUN_LABEL}`, '--format', '{{.ID}}'],
        { timeout: 15_000 },
      );
      ids = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      // Docker apagado no es un error del barrido: si no hay daemon, tampoco
      // hay containers huérfanos que limpiar.
      return [];
    }

    if (ids.length === 0) return [];

    // Un solo inspect para todos: N llamadas a docker por barrido serían
    // N arranques de proceso cada 30 segundos.
    const { stdout } = await run(
      'docker',
      [
        'inspect',
        '--format',
        `{{.Id}} {{index .Config.Labels "${RUN_LABEL}"}} {{.Created}}`,
        ...ids,
      ],
      { timeout: 15_000 },
    );

    const now = Date.now();
    const managed: ManagedSandbox[] = [];

    for (const line of stdout.split('\n')) {
      const [containerId, runId, created] = line.trim().split(' ');
      if (!containerId || !runId || !created) continue;

      const createdAt = Date.parse(created);
      managed.push({
        containerId,
        runId,
        // Un `Created` ilegible no debe hacer que el container parezca recién
        // nacido para siempre: sin edad confiable, que lo juzgue la base.
        ageMs: Number.isNaN(createdAt) ? Number.POSITIVE_INFINITY : now - createdAt,
      });
    }

    return managed;
  }

  async destroy(containerId: string): Promise<void> {
    try {
      await run('docker', ['rm', '-f', containerId], { timeout: 30_000 });
    } catch {
      // Otro barrido pudo habérselo llevado primero. Que ya no exista es
      // exactamente el resultado buscado.
    }
  }
}
