/**
 * Puerto de sandbox: el entorno aislado donde el agente ejecuta.
 *
 * Hoy lo implementa Docker local. Si algún día se usa Managed Agents,
 * el adapter cambia y el loop del agente no se entera.
 *
 * Regla: NADA de lo que el agente pida se ejecuta fuera de este puerto.
 * Es la única frontera entre el modelo y la máquina.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxPort {
  /** Levanta el entorno. Idempotente. */
  start(): Promise<void>;

  /** Ejecuta un comando de shell dentro del sandbox. */
  exec(command: string): Promise<ExecResult>;

  /** Escribe un archivo. Crea los directorios padre. */
  writeFile(path: string, content: string): Promise<void>;

  readFile(path: string): Promise<string>;

  /** Destruye el entorno. Debe ser seguro llamarlo dos veces. */
  stop(): Promise<void>;
}
