# Spec 003 — Ramas y pull requests

**Fase:** 2 · **Estado:** Especificada

## Objetivo

Que el trabajo del agente salga del sandbox y llegue a un Pull Request revisable.

## El problema a resolver primero

Hoy `sandbox.stop()` destruye el container y **los archivos que el agente
escribió se pierden**. En la fase 1 no importa: sólo verificamos que el loop
cierre. Pero no se puede abrir un PR con código que ya no existe.

Extraer el trabajo antes de destruir el container es **prerequisito**, no una
mejora.

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

Antes del `stop()`, dentro del sandbox:

```bash
git add -A && git commit -m "<mensaje>"
git format-patch origin/main --stdout
```

El patch se guarda en `agent_runs.patch` (o en un blob con puntero, si es
grande). Así el trabajo sobrevive al container aunque el push falle, y el PR se
puede reintentar sin reejecutar al agente.

**Esto es lo que hace que un fallo en el paso 4 o 5 no desperdicie una corrida
completa.**

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

El PAT del repositorio **no entra al container**. Las operaciones de git salen
por un proxy que inyecta el token después de que la request abandona el sandbox.
Código que corra dentro —incluido el que escriba el agente— no puede leerlo.

Con Docker local hay que construir ese proxy, o aceptar que el token vive en el
container. **Si se acepta, hay que declararlo**: contradice parcialmente el
[ADR 0003](../adr/0003-sandbox-como-unica-frontera.md) y sube el riesgo de una
inyección de prompt.

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

- [ ] El patch se persiste antes de destruir el container.
- [ ] Un ticket ejecutado produce una rama `feature/TICKET-<id>` con commits.
- [ ] Se crea el PR y el ticket pasa a `PR_OPEN`.
- [ ] El cuerpo del PR se arma desde la traza, no desde el texto del agente.
- [ ] Si el PR falla y el push no, reintentar no reejecuta al agente.
- [ ] El PAT no aparece en ninguna fila de `agent_events`.
