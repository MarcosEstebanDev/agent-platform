/**
 * Puerto de control de versiones: llevar el trabajo del agente a un Pull
 * Request.
 *
 * Todo esto corre del lado del orquestador, con sus credenciales. El sandbox
 * no lo ve ni lo puede pedir (ADR 0010).
 *
 * La spec 003 proponia `createBranch` + `pushBranch` sobre un clon local. El
 * adapter real arma el commit con la API de GitHub, sin clonar, asi que el
 * puerto habla de lo que se quiere (commitear estos archivos en esta rama) y
 * no de como se hace con git (ver ADR 0012).
 */

export interface CommitFile {
  path: string;
  content: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/**
 * Por que fallo una operacion, en terminos que el caso de uso puede decidir.
 *
 * - `branch_exists`: la rama ya existe y no es nuestra. Se reintenta con sufijo.
 * - `forbidden`: el token no tiene el permiso. Reintentar no lo arregla.
 * - `not_found`: el repo o la rama base no existen, o el token no los ve.
 * - `unavailable`: GitHub fallo o no respondio. Reintentable.
 */
export type VcsErrorKind = 'branch_exists' | 'forbidden' | 'not_found' | 'unavailable';

export class VcsError extends Error {
  constructor(
    readonly kind: VcsErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'VcsError';
  }
}

export interface VcsPort {
  /**
   * Verifica que el repo exista y sea alcanzable con el token.
   *
   * Corre ANTES de gastar tokens del LLM: descubrir al final de una corrida de
   * diez minutos que el repo estaba mal escrito es la forma cara de enterarse.
   */
  checkAccess(repo: string): Promise<void>;

  /**
   * Commitea los archivos en `branch`.
   *
   * Si la rama no existe, la crea desde `base`. Si existe y `createOnly` es
   * true, lanza `VcsError('branch_exists')` en vez de escribir encima de algo
   * que no se sabe de quien es.
   */
  commitFiles(input: {
    repo: string;
    branch: string;
    base: string;
    message: string;
    files: CommitFile[];
    createOnly: boolean;
  }): Promise<{ sha: string }>;

  /** El PR abierto desde `branch`, si hay. Es lo que hace idempotente abrirlo. */
  findOpenPullRequest(repo: string, branch: string): Promise<PullRequestRef | null>;

  openPullRequest(input: {
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef>;
}
