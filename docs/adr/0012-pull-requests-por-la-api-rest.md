# ADR 0012 — Los PRs se arman con la API REST de GitHub, sin clonar

**Estado:** Aceptada · 2026-10-27 · Se aparta de la [spec 003](../specs/003-pull-requests.md) en el *cómo*, no en el *qué*

## Contexto

La spec 003 proponía dos mecanismos:

| Necesidad | Mecanismo de la spec |
|---|---|
| Rama, commit, push | git sobre un clon del repo |
| Crear el PR | Servidor MCP de GitHub (`api.githubcopilot.com/mcp/`) |

Y un puerto con la forma de git: `createBranch`, `pushBranch`,
`openPullRequest`, `getChecks`.

Con [ADR 0010](0010-git-fuera-del-sandbox.md), git ya corría del lado del
orquestador. Al implementarlo, ese lado resultó tener un problema propio: el
worker no tiene git garantizado. En la máquina donde se desarrolla esto, de
hecho, git es un binario portable fuera del `PATH`. Clonar además exige un
directorio temporal por corrida, limpiarlo, y pasarle el PAT a git sin que
termine en una URL o en el `argv` de un proceso (que `ps` muestra).

El servidor MCP, por su lado, sumaba una segunda credencial (OAuth bearer, no
el PAT) y un protocolo entero para hacer **un** POST.

## Decisión

**Todo por la API REST de GitHub, con el PAT como única credencial.**

El commit se arma con la Git Data API, a partir de los archivos que ya están en
`run_artifacts`:

```
GET  /git/ref/heads/<rama>        ¿existe? → padre = su HEAD
GET  /git/ref/heads/<base>        si no    → padre = HEAD de la base
GET  /git/commits/<padre>         → árbol del padre
POST /git/trees     base_tree = árbol del padre, + archivos del agente
POST /git/commits   parents = [padre]
POST /git/refs      (rama nueva)   |   PATCH /git/refs/heads/<rama>  force: false
```

`base_tree` es lo que hace que los archivos se **sumen** al repo en vez de
reemplazarlo. `force: false` es lo que hace que un push concurrente falle en vez
de pisar trabajo ajeno.

El puerto deja de hablar de git y habla de lo que se quiere:

```ts
interface VcsPort {
  checkAccess(repo): Promise<void>;
  commitFiles({ repo, branch, base, message, files, createOnly }): Promise<{ sha }>;
  findOpenPullRequest(repo, branch): Promise<PullRequestRef | null>;
  openPullRequest({ repo, branch, base, title, body }): Promise<PullRequestRef>;
}
```

`getChecks` salió de este puerto y se fue a `QualityGatePort`
([ADR 0013](0013-el-veredicto-de-los-gates-vive-en-el-dominio.md)): leer CI no
es control de versiones. Un solo adapter (`GitHubRestAdapter`) implementa los
dos puertos, pero el dominio no lo sabe.

## Consecuencias

**A favor**

- El worker no necesita git, ni disco temporal, ni limpieza.
- Una sola credencial. Viaja en el header `Authorization` y en ningún otro
  lado; los mensajes de error se tachan aunque GitHub devuelva el token.
- Todo el adapter se prueba con un `fetch` falso, sin red.
- El ciclo de corrección de la spec 004 sale gratis: un segundo commit sobre la
  misma rama actualiza el PR abierto, y CI vuelve a correr solo.

**En contra**

- **El agente no puede borrar ni renombrar archivos.** Un tree con `base_tree`
  solo agrega o modifica. Borrar exige listar entradas con `sha: null`, y el
  artefacto no registra borrados porque el workspace arranca vacío (ver abajo).
- **El agente no ve el repo.** El sandbox arranca vacío: el agente escribe
  archivos nuevos o reescribe los que conoce por el task, pero no lee el código
  existente. Sembrar el workspace con el repo es la mejora natural y no entró
  en esta fase.
- Cada archivo viaja inline en el JSON del tree. Con los techos del rescate
  (4 MB en total) entra holgado en los límites de la API; si los techos suben,
  hay que pasar a blobs separados.
- Atado a GitHub. Otro proveedor (GitLab, Gitea) es otro adapter del mismo
  puerto, no un cambio de dominio.
