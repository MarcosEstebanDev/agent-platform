import type {
  SandboxContext,
  SandboxFactoryPort,
} from '../../domain/ports/sandbox-factory.port.js';
import type { SandboxPort } from '../../domain/ports/sandbox.port.js';
import { DockerSandbox, type DockerSandboxOptions } from './docker.sandbox.js';

/** Un container nuevo por corrida. Ningún ticket ve lo que dejó otro. */
export class DockerSandboxFactory implements SandboxFactoryPort {
  constructor(private readonly options: DockerSandboxOptions = {}) {}

  create(context: SandboxContext): SandboxPort {
    // El runId viaja hasta el label del container. Es lo único que después
    // permite decidir si un container que sobrevivió a su worker es basura
    // o alguien trabajando.
    return new DockerSandbox({ ...this.options, runId: context.runId });
  }
}
