# Spec 003 — Ramas y pull requests

**Fase:** 2 · **Estado:** Prerequisito implementado, PRs pendientes

> El rescate del trabajo (la sección "El problema a resolver primero") está
> hecho y verificado. Todo lo que sigue —ramas, push, PR— no.

## Objetivo

Que el trabajo del agente salga del sandbox y llegue a un Pull Request revisable.

## El problema a resolver primero

Hoy `sandbox.stop()` destruye el container y **los archivos que el agente
escribió se pierden**. En la fase 1 no importa: sólo verificamos que el loop
cierre. Pero no se puede abrir un PR con código que ya no existe.

Extraer el trabajo antes de destruir el container es **prerequisito**, no una
mejora.

> **Resuelto el 2026-08-24.** `SandboxPort.exportFiles()` saca el workspace y
> lo persiste en `run_artifacts` antes del `stop()`. Ver
> [ADR 0010](../adr/0010-git-fuera-del-sandbox.md) y la sección
> [Extracción del trabajo](#extracción-del-trabajo), reescrita con lo que se
> construyó.

## Dos mecanismos, no uno

Es la confusión más común y cuesta horas:

| Necesidad | Mecanismo | Autenticación |
|---|---|---|
| Clonar, commitear, `git push` | Repo montado en el sandbox | PAT con `Contents: Read and write` |
| **Crear el Pull Request** | **GitHub MCP server** | Credencial aparte |

Montar el repo da filesystem y git. **No crea PRs.** Eso requiere la API de
GitHub, expuesta vía el servidor MCP en `https://api.githubcopilot.com/mcp/`.

> Ese dominio dice "copilot", pero **no es GitHub Copilot el asistente**. Es el
> servidor MCP de GitHub. No hace falta suscripción a Copilot.

Además, los servidores MCP suelen pedir **OAuth bearer token**, no la API key
nativa del servicio. Son sistemas de autenticación distintos y no son
intercambiables.

## Flujo

```
IN_PROGRESS
   │
   ├─ 1. Clonar el repo en el sandbox, rama feature/TICKET-<id>
   ├─ 2. El agente trabaja (fase 1, sin cambios)
   ├─ 3. Extraer el diff ANTES de destruir el container
   ├─ 4. git push de la rama
   └─ 5. Crear el PR
         │
         ▼
      PR_OPEN
```

### Estados nuevos

```
IN_PROGRESS ──▶ PR_OPEN ──▶ DONE
      │            │
      └──▶ FAILED ◀┘
```

`PR_OPEN` no es cosmético: es el estado donde el ticket espera una señal
externa (los checks de CI, ver [spec 004](004-gates-de-calidad.md)).

### Extracción del trabajo

> Reescrita el 2026-08-24. El diseño original hacía `git format-patch` **dentro**
> del container; ver abajo por qué no.

El sandbox exporta los archivos; git corre del lado del orquestador
([ADR 0010](../adr/0010-git-fuera-del-sandbox.md)).

```
SANDBOX (sin git, sin red, sin credenciales)
  /workspace  ──exportFiles()──▶  archivos
                                     │
ORQUESTADOR                          ▼
  run_artifacts  ──▶  git apply / commit / push  ──▶  PR
                          el PAT vive sólo acá
```

**Por qué no adentro.** La imagen del sandbox no trae git, pero eso es lo de
menos: se compra una imagen más pesada. El problema real es que esta misma spec
exige, en [Credenciales](#credenciales), que el PAT **no** entre al container —
y con git adentro eso obliga a construir un proxy cuyo único propósito es
sostener la contradicción. Con git afuera no hay token que proteger adentro.

Lo extraído se persiste en `run_artifacts` (tabla aparte de `agent_runs`, para
no encarecer el listado que el tablero pide todo el tiempo):

| Columna | Qué guarda |
|---|---|
| `files` | `[{ path, content, bytes }]` |
| `skipped` | `[{ path, bytes, reason }]` — lo que no entró, y por qué |
| `file_count`, `total_bytes`, `truncated` | resumen barato de consultar |

Techos por default: 512 KB por archivo, 4 MB en total, podando `node_modules`,
`.git`, `dist` y `.next` por nombre a cualquier profundidad. Lo que se pasa se
registra como omitido (`too_large`, `budget`) en vez de desaparecer. Los
binarios se detectan por byte nulo y se omiten (`binary`): guardarlos como texto
los corrompería en silencio.

El rescate **no puede tumbar la corrida**. Si el agente resolvió la tarea, que
falle sacar los archivos no invalida lo que hizo: el error queda en la traza
como evento `artifact` y la corrida cierra con su veredicto. Cuando esta fase
abra PRs, sin artefacto no habrá PR posible — pero esa decisión pertenece al
flujo del PR, no al rescate.

Expuesto en `GET /tickets/:id/runs/:runId/artifact`.

### Puerto nuevo

```ts
export interface VcsPort {
  createBranch(repo: string, branch: string, base: string): Promise<void>;
  pushBranch(repo: string, branch: string): Promise<void>;
  openPullRequest(input: {
    repo: string; branch: string; base: string;
    title: string; body: string;
  }): Promise<{ number: number; url: string }>;
  getChecks(repo: string, prNumber: number): Promise<CheckStatus[]>;
}
```

Adapter: `GitHubMcpAdapter`. El dominio no sabe que existe GitHub — igual que no
sabe que existe Groq ([ADR 0002](../adr/0002-proveedor-de-llm-agnostico.md)).

### Credenciales

El PAT del repositorio **no entra al container**, y no hace falta ningún proxy
para lograrlo: git no corre adentro
([ADR 0010](../adr/0010-git-fuera-del-sandbox.md)). El sandbox sólo ejecuta
código no confiable y devuelve archivos; clonar, pushear y abrir el PR pasan del
lado del orquestador.

Importa más de lo que parece: lo que corre en el sandbox es código escrito por
un modelo a partir de texto que no controlamos. Un PAT con `Contents: write` ahí
adentro es exactamente lo que una inyección de prompt querría encontrar.

## Contenido del PR

Generado por el orquestador desde la traza, **no** pedido al agente:

```markdown
## <título del ticket>
<task del ticket>

### Qué hizo el agente
- 3 archivos escritos
- `npm test` → exit 0

---
Ticket: <id> · Corrida: <runId> · Modelo: <modelo> · 4 iteraciones · 2.4k tokens
```

Por qué desde la traza: es evidencia verificable, no una narración del modelo
sobre sí mismo ([ADR 0007](../adr/0007-el-veredicto-no-es-del-agente.md)).

## Modos de falla

| Falla | Comportamiento |
|---|---|
| Clonar falla | `FAILED` antes de gastar tokens |
| Push rechazado (rama existe) | Sufijo `-2`, reintento |
| PR falla pero el push salió | El ticket queda en `IN_PROGRESS` con patch y rama guardados; reintentable sin reejecutar al agente |
| Sin permiso `Contents: write` | `FAILED` con mensaje explícito sobre el scope faltante |

## Criterio de aceptación

- [x] El trabajo se persiste antes de destruir el container.
      → `exportFiles()` corre en el `finally`, antes de `stop()`; el test
      verifica el ORDEN, no sólo que ambos pasen.
- [ ] Un ticket ejecutado produce una rama `feature/TICKET-<id>` con commits.
- [ ] Se crea el PR y el ticket pasa a `PR_OPEN`.
- [ ] El cuerpo del PR se arma desde la traza, no desde el texto del agente.
- [ ] Si el PR falla y el push no, reintentar no reejecuta al agente.
- [ ] El PAT no aparece en ninguna fila de `agent_events`.
