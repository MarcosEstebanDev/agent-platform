/**
 * Puerto de sandbox: el entorno aislado donde el agente ejecuta.
 *
 * Hoy lo implementa Docker local. Si algún día se usa Managed Agents,
 * el adapter cambia y el loop del agente no se entera.
 *
 * Regla: NADA de lo que el agente pida se ejecuta fuera de este puerto.
 * Es la única frontera entre el modelo y la máquina.
 *
 * Corolario deliberado: acá no hay git. El sandbox ejecuta código no
 * confiable y nada más; clonar, commitear y pushear pasan del lado del
 * orquestador, para que ninguna credencial cruce esta frontera
 * (ver ADR 0010).
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Un archivo que el agente dejó en el workspace. */
export interface WorkspaceFile {
  /** Relativo a la raíz del workspace, sin `./`. */
  path: string;
  content: string;
  bytes: number;
}

/**
 * Por qué un archivo quedó afuera. No es ruido: si el trabajo del agente no
 * sobrevive entero, el que mire el PR tiene que poder saber qué falta.
 */
export type SkipReason = 'too_large' | 'binary' | 'budget';

export interface SkippedFile {
  path: string;
  bytes: number;
  reason: SkipReason;
}

export interface ExportOptions {
  /** Techo por archivo. Arriba de esto se omite y se registra. */
  maxFileBytes?: number;
  /** Techo del total. Al agotarse, lo que falta se omite como 'budget'. */
  maxTotalBytes?: number;
  /** Rutas que nunca se exportan (subcadenas). */
  exclude?: string[];
}

export interface WorkspaceExport {
  files: WorkspaceFile[];
  skipped: SkippedFile[];
  totalBytes: number;
  /** `true` si algo quedó afuera. Atajo para no recorrer `skipped`. */
  truncated: boolean;
}

export interface SandboxPort {
  /** Levanta el entorno. Idempotente. */
  start(): Promise<void>;

  /** Ejecuta un comando de shell dentro del sandbox. */
  exec(command: string): Promise<ExecResult>;

  /** Escribe un archivo. Crea los directorios padre. */
  writeFile(path: string, content: string): Promise<void>;

  readFile(path: string): Promise<string>;

  /**
   * Saca el trabajo del sandbox antes de destruirlo.
   *
   * Existe porque `stop()` es irreversible: sin esto, lo que el agente
   * escribió muere con el container y no hay nada que poner en un PR.
   * Los techos son parte del contrato — un agente puede dejar un
   * `node_modules` de cientos de megas, y exportar sin límite es una forma
   * prolija de tumbar el worker.
   */
  exportFiles(options?: ExportOptions): Promise<WorkspaceExport>;

  /** Destruye el entorno. Debe ser seguro llamarlo dos veces. */
  stop(): Promise<void>;
}
