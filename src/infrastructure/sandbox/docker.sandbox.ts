import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ExecResult, SandboxPort } from '../../domain/ports/sandbox.port.js';

const run = promisify(execFile);

export interface DockerSandboxOptions {
  image?: string;
  /** 'none' aisla el container de la red. Ponelo en 'bridge' si el agente
   *  necesita npm install o salir a internet — y entendé el riesgo. */
  network?: 'none' | 'bridge';
  memory?: string;
  cpus?: string;
  /** Timeout por comando, en milisegundos. */
  timeoutMs?: number;
}

/**
 * Sandbox sobre Docker local.
 *
 * Todo lo que el agente ejecuta pasa por acá. Es la única frontera entre
 * el modelo y tu máquina, así que los defaults son restrictivos:
 * sin red, memoria y CPU acotadas, y timeout por comando.
 *
 * Nada se ejecuta en la shell del host: siempre execFile con args en array,
 * nunca interpolación de strings en un shell local.
 */
export class DockerSandbox implements SandboxPort {
  private containerId: string | null = null;
  private readonly opts: Required<DockerSandboxOptions>;

  constructor(options: DockerSandboxOptions = {}) {
    this.opts = {
      image: options.image ?? 'node:22-bookworm-slim',
      network: options.network ?? 'none',
      memory: options.memory ?? '2g',
      cpus: options.cpus ?? '2',
      timeoutMs: options.timeoutMs ?? 120_000,
    };
  }

  async start(): Promise<void> {
    if (this.containerId) return;

    try {
      await run('docker', ['version', '--format', '{{.Server.Version}}']);
    } catch {
      throw new Error(
        'No se puede hablar con el daemon de Docker. ¿Está corriendo Docker Desktop?',
      );
    }

    const name = `agent-sbx-${randomUUID().slice(0, 8)}`;
    // -w crea el directorio si no existe. `sleep infinity` mantiene vivo el
    // container para poder hacerle exec varias veces.
    const { stdout } = await run(
      'docker',
      [
        'run', '-d', '--rm',
        '--name', name,
        '--network', this.opts.network,
        '--memory', this.opts.memory,
        '--cpus', this.opts.cpus,
        '-w', '/workspace',
        this.opts.image,
        'sleep', 'infinity',
      ],
      { timeout: 300_000 }, // el primer run puede tener que bajarse la imagen
    );

    this.containerId = stdout.trim();
  }

  async exec(command: string): Promise<ExecResult> {
    const id = this.requireContainer();
    try {
      const { stdout, stderr } = await run(
        'docker',
        ['exec', '-w', '/workspace', id, 'bash', '-c', command],
        { timeout: this.opts.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      // execFile rechaza cuando el exit code no es 0, pero igual trae la salida.
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      if (e.killed) {
        return {
          stdout: e.stdout ?? '',
          stderr: `Comando cancelado por timeout (${this.opts.timeoutMs} ms)`,
          exitCode: 124,
        };
      }
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? String(err),
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  /** El contenido va por stdin, no como argumento: sin límite de tamaño
   *  y sin problemas de escapeo. */
  async writeFile(path: string, content: string): Promise<void> {
    const id = this.requireContainer();
    const dir = path.replace(/\/[^/]*$/, '') || '/';

    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', [
        'exec', '-i', id,
        'bash', '-c', `mkdir -p "${dir}" && cat > "${path}"`,
      ]);

      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`write_file falló (exit ${code}): ${stderr}`)),
      );

      child.stdin.end(content, 'utf8');
    });
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec(`cat "${path}"`);
    if (result.exitCode !== 0) {
      throw new Error(`No se pudo leer ${path}: ${result.stderr}`);
    }
    return result.stdout;
  }

  async stop(): Promise<void> {
    if (!this.containerId) return;
    const id = this.containerId;
    this.containerId = null;
    try {
      await run('docker', ['rm', '-f', id], { timeout: 30_000 });
    } catch {
      // El container ya puede haber muerto; no es un error que valga la pena propagar.
    }
  }

  private requireContainer(): string {
    if (!this.containerId) {
      throw new Error('El sandbox no está iniciado. Llamá a start() primero.');
    }
    return this.containerId;
  }
}
