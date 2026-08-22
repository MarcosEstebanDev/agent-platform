import type { SandboxFactoryPort } from '../../domain/ports/sandbox-factory.port.js';
import type { SandboxPort } from '../../domain/ports/sandbox.port.js';
import { DockerSandbox, type DockerSandboxOptions } from './docker.sandbox.js';

/** Un container nuevo por corrida. Ningún ticket ve lo que dejó otro. */
export class DockerSandboxFactory implements SandboxFactoryPort {
  constructor(private readonly options: DockerSandboxOptions = {}) {}

  create(): SandboxPort {
    return new DockerSandbox(this.options);
  }
}
