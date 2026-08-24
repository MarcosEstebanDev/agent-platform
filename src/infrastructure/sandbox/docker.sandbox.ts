import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type {
  ExecResult,
  ExportOptions,
  SandboxPort,
  SkippedFile,
  WorkspaceExport,
  WorkspaceFile,
} from '../../domain/ports/sandbox.port.js';

/**
 * Label que marca un container como nuestro y dice de qué corrida es.
 *
 * Es la identidad que permite limpiar huérfanos sin adivinar: filtrar por
 * nombre (`agent-sbx-*`) alcanzaría para encontrarlos, pero no para saber
 * cuáles siguen trabajando.
 */
export const RUN_LABEL = 'agent-platform.run';

/** Directorios que nunca son "el trabajo del agente": se podan por nombre, a
 *  cualquier profundidad. */
const DEFAULT_EXCLUDE = ['node_modules', '.git', 'dist', '.next'];

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
  /**
   * Corrida dueña del container. Se escribe como label.
   *
   * Sin runId el container NO se etiqueta, y por lo tanto es invisible para
   * el barrido de huérfanos. Es deliberado: un sandbox suelto (`npm run run`)
   * no tiene fila en `agent_runs`, así que nadie puede decidir si sigue
   * trabajando — y lo que la base no puede juzgar, no se barre.
   */
  runId?: string;
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
  private readonly opts: Omit<Required<DockerSandboxOptions>, 'runId'> & {
    runId?: string;
  };

  constructor(options: DockerSandboxOptions = {}) {
    this.opts = {
      image: options.image ?? 'node:22-bookworm-slim',
      network: options.network ?? 'none',
      memory: options.memory ?? '2g',
      cpus: options.cpus ?? '2',
      timeoutMs: options.timeoutMs ?? 120_000,
      runId: options.runId,
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
        ...(this.opts.runId ? ['--label', `${RUN_LABEL}=${this.opts.runId}`] : []),
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

  /**
   * Saca el trabajo del sandbox antes de destruirlo.
   *
   * El container emite una línea por archivo con la forma
   * `<ruta-b64> <bytes> <estado> [contenido-b64]`. La ruta y el contenido van
   * en base64 no por gusto: una ruta con espacios, comillas o un salto de
   * línea rompe cualquier parseo por delimitador, y un archivo con comillas
   * adentro rompe el JSON armado a mano en bash. En base64 no existen
   * caracteres conflictivos, así que el escapeo deja de ser una categoría
   * de bug.
   *
   * Los techos se aplican DENTRO del shell. Si se filtraran del lado de Node,
   * los cientos de megas ya habrían viajado por el pipe y reventado el
   * `maxBuffer` de execFile antes de que nadie pudiera descartarlos.
   */
  async exportFiles(options: ExportOptions = {}): Promise<WorkspaceExport> {
    const result = await this.exec(buildExportScript(options));
    if (result.exitCode !== 0) {
      throw new Error(`No se pudo exportar el workspace: ${result.stderr}`);
    }
    return parseExportOutput(result.stdout);
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

/**
 * El script que corre DENTRO del container para sacar el workspace.
 *
 * Emite una linea por archivo: `<ruta-b64> <bytes> <estado> [contenido-b64]`.
 *
 * La ruta y el contenido van en base64 no por gusto: una ruta con espacios,
 * comillas o un salto de linea rompe cualquier parseo por delimitador, y un
 * archivo que contenga comillas rompe el JSON armado a mano en bash. En base64
 * no existen caracteres conflictivos, asi que el escapeo deja de ser una
 * categoria de bug.
 *
 * Los techos se aplican ACA, dentro del shell. Filtrar del lado de Node
 * llegaria tarde: los cientos de megas ya habrian viajado por el pipe y
 * reventado el `maxBuffer` de execFile antes de que nadie pudiera
 * descartarlos.
 *
 * Se exporta para poder verificarlo contra un bash real, sin Docker.
 */
export function buildExportScript(options: ExportOptions = {}, root = '/workspace'): string {
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 4 * 1024 * 1024;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;

  // Se poda por NOMBRE de directorio, no por ruta: `-path './node_modules/*'`
  // solo alcanzaria al de la raiz y dejaria entrar los anidados, que es
  // exactamente donde vive el peso.
  //
  // Los patrones vienen de configuracion y no del agente, pero igual se
  // sanean: cualquier cosa fuera de este alfabeto podria cerrar la comilla y
  // seguir escribiendo shell.
  const pruned = exclude
    .map((name) => name.replace(/[^A-Za-z0-9._-]/g, ''))
    .filter(Boolean)
    .map((name) => `-name '${name}' -prune -o`)
    .join(' ');

  return `
    cd ${root} 2>/dev/null || exit 0
    total=0
    find . ${pruned} -type f -print0 2>/dev/null | while IFS= read -r -d '' f; do
      sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
      p64=$(printf %s "\${f#./}" | base64 -w0)
      if [ "$sz" -gt ${maxFileBytes} ]; then
        echo "$p64 $sz too_large"
      elif [ $((total + sz)) -gt ${maxTotalBytes} ]; then
        echo "$p64 $sz budget"
      else
        total=$((total + sz))
        echo "$p64 $sz ok $(base64 -w0 < "$f")"
      fi
    done
  `;
}

/**
 * Convierte la salida del script en el resultado del puerto.
 *
 * Es una funcion pura a proposito: el riesgo real de la extraccion son las
 * rutas raras (comillas, espacios, acentos, saltos de linea) y los archivos
 * binarios, y todo eso se puede verificar sin container, sin bash y sin
 * sistema de archivos.
 *
 * Detalle conocido: un binario CONSUME presupuesto aunque despues se descarte,
 * porque el shell cuenta los bytes y la deteccion pasa aca. Detectarlo del
 * lado del container costaria una pasada extra por archivo; se prefiere que un
 * workspace lleno de binarios rinda menos texto antes que encarecer el caso
 * normal.
 */
export function parseExportOutput(stdout: string): WorkspaceExport {
  const files: WorkspaceFile[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [p64, rawSize, state, body] = line.trim().split(' ');
    if (!p64 || !state) continue;

    const path = Buffer.from(p64, 'base64').toString('utf8');
    const bytes = Number.parseInt(rawSize ?? '0', 10) || 0;

    if (state === 'too_large' || state === 'budget') {
      skipped.push({ path, bytes, reason: state });
      continue;
    }
    if (state !== 'ok') continue;

    const buf = Buffer.from(body ?? '', 'base64');
    // Un byte nulo significa binario. Guardarlo como texto lo corromperia en
    // silencio, que es peor que decir que no vino.
    if (buf.includes(0)) {
      skipped.push({ path, bytes, reason: 'binary' });
      continue;
    }

    files.push({ path, content: buf.toString('utf8'), bytes });
    totalBytes += bytes;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped, totalBytes, truncated: skipped.length > 0 };
}
