# agent-platform

Plataforma de orquestación de agentes de desarrollo: un agente coordinador
organiza tickets, delega implementación, y el ciclo cierra con PR, tests y deploy.

**Agnóstica del proveedor.** El dominio no sabe qué LLM ni qué sandbox hay
debajo — eso vive en adapters intercambiables.

## Lo interesante

**Esto no es un proyecto sobre LLMs.** Es un proyecto sobre orquestar trabajo
distribuido y poco confiable, donde el que ejecuta puede morir a la mitad y
nadie avisa. El LLM es apenas el worker; casi todo el código es estado durable,
idempotencia, límites y reintentos.

Los problemas concretos que resuelve, y dónde está la respuesta:

| Problema | Cómo se resuelve | Dónde |
|---|---|---|
| Un worker muere en medio de una corrida y nadie lo notifica | Latido periódico + un reaper que cierra lo que dejó de latir. El peor caso es **umbral + intervalo de barrido**, no el umbral solo: 90 s + 30 s = 2 min acotados por diseño | [ADR 0008](docs/adr/0008-liveness-por-latido.md) |
| El estado guardado miente sobre la realidad | El claim `ASSIGNED→IN_PROGRESS` lo hace el **worker**, no la API. Si lo hiciera la API, un ticket encolado y jamás tomado figuraría "en progreso" sin nadie corriendo — y el reaper perdería su única prueba de muerte | [ADR 0009](docs/adr/0009-la-api-no-ejecuta.md) |
| El mismo trabajo se encola dos veces | `jobId = ticketId`: idempotente por construcción, no por chequeo | [spec 002](docs/specs/002-ejecucion-asincrona.md) |
| Una corrida que no termina nunca | Tres presupuestos (iteraciones, tokens, reloj) y el que corte primero gana. El reloj arranca **antes** de levantar el container, porque levantarlo también cuesta | `domain/agent-runner.ts` |
| El trabajo se pierde al destruir el sandbox | Se exporta el workspace en base64 —el escapeo deja de ser una categoría de bug— con los techos aplicados *dentro* del shell, y se persiste **antes** de `stop()` | `infrastructure/sandbox/` |
| Containers huérfanos cuando el worker cae | Cada container lleva el id de su corrida como label; un janitor destruye aquellos que la base da por cerrados. Reaper y janitor **no se conocen**: se coordinan por la base | [ADR 0011](docs/adr/0011-identidad-del-container.md) |
| Que no haya credenciales dentro del sandbox | Git no entra. Clonar, commitear y pushear pasan del lado del orquestador, así que no hay token adentro que proteger | [ADR 0010](docs/adr/0010-git-fuera-del-sandbox.md) |
| El agente se autoaprueba ("all tests pass") | La lista blanca no tiene `IN_PROGRESS → DONE`. El agente termina en un PR, y DONE lo dan los checks de CI que el agente no puede escribir: regla pura en el dominio, webhook firmado + poller de respaldo, tope de 3 rechazos | [ADR 0013](docs/adr/0013-el-veredicto-de-los-gates-vive-en-el-dominio.md) |
| Que el PR falle y haya que volver a pagar al agente | La rama se guarda apenas se pushea, antes del PR. Reintentar el PR usa el trabajo ya rescatado: cero tokens | [ADR 0012](docs/adr/0012-pull-requests-por-la-api-rest.md) |
| Probar todo esto sin levantar nada | Puertos + dobles: **140 tests en ~1 s**, sin base, sin Docker, sin Redis, sin LLM y sin GitHub | [Tests](#tests) |

> Proyecto de portfolio. El objetivo es mostrar el **criterio detrás de cada
> decisión** —documentado como ADRs, incluidas las veces que el diseño chocó
> con la realidad y hubo que corregirlo— antes que la cantidad de features.

## Arquitectura

```
src/
├── domain/                    ← puro, sin frameworks ni SDKs
│   ├── ports/
│   │   ├── llm.port.ts        "completá con estas tools"
│   │   ├── sandbox.port.ts    "ejecutá esto aislado" + "sacá el trabajo"
│   │   ├── sandbox-janitor.port.ts  limpieza de containers huérfanos
│   │   ├── queue.port.ts      "encolá esta corrida"
│   │   ├── vcs.port.ts        "commiteá esto en esta rama" + "abrí el PR"
│   │   ├── quality-gate.port.ts  "¿qué dice CI de este PR?"
│   │   └── ticket-repository.port.ts
│   ├── agent-runner.ts        el loop del agente + presupuestos
│   ├── pull-request-body.ts   el cuerpo del PR, desde la traza
│   ├── quality-gates.ts       qué es pasar los gates, y el feedback del reintento
│   └── ticket.ts              máquina de estados (lista blanca de transiciones)
├── application/
│   ├── enqueue-ticket.use-case.ts   valida, marca ASSIGNED y encola
│   ├── run-ticket.use-case.ts       claim → agente → traza → PR
│   ├── open-pull-request.use-case.ts  rama, commit y PR, reintentable sin el agente
│   ├── evaluate-gates.use-case.ts   checks de CI → DONE o ciclo de corrección
│   ├── reap-stale-runs.use-case.ts  cierra corridas sin latido
│   ├── sweep-orphan-sandboxes.use-case.ts  destruye containers huérfanos
│   └── fakes.ts                     dobles de prueba compartidos
├── infrastructure/
│   ├── llm/openai-compatible.adapter.ts   cualquier proveedor OpenAI-compatible
│   ├── queue/bullmq-queue.adapter.ts      BullMQ + Redis
│   ├── persistence/                       Prisma 7 (driver adapter)
│   ├── sandbox/                           Docker local, un container por corrida
│   └── github/                            API REST (commit sin clonar, PRs, checks) + webhook
├── api/                       NestJS: encola, consulta y recibe el webhook. NO ejecuta agentes.
├── worker/                    consume la cola, corre el agente, late, barre y sondea CI
├── config.ts                  lectura de env compartida
├── dlq.ts                     inspecciona y rescata jobs muertos
├── run.ts                     agente suelto, sin persistencia
├── models.ts                  lista los modelos que habilita tu API key
├── smoke.ts                   verifica el sandbox sin usar el LLM
└── db-smoke.ts                verifica la persistencia sin usar el LLM

apps/dashboard/                Next.js 15: tablero y traza en vivo (puerto 4000)
reference/managed-agents/      Managed Agents de Anthropic (requiere API key)
```

Cambiar de proveedor es **cambiar tres líneas del `.env`**. El `agent-runner`
y el sandbox no se tocan.

**Dos procesos, no uno.** La API valida, persiste y encola; el worker ejecuta.
La API arranca sin `LLM_API_KEY` y sin Docker — ver
[ADR 0009](docs/adr/0009-la-api-no-ejecuta.md).

**Git no entra al sandbox.** El sandbox ejecuta código no confiable y devuelve
archivos; clonar, commitear y pushear pasan del lado del orquestador, así que
ninguna credencial cruza esa frontera — ver
[ADR 0010](docs/adr/0010-git-fuera-del-sandbox.md).

## Estado

| Fase | Qué | Estado |
|---|---|---|
| **0a** | Sandbox Docker aislado, con exec / write / read | ✅ verificado |
| **0b** | Loop de agente cerrando una tarea end-to-end | ✅ verificado |
| **1** | Orquestador NestJS: ticket + máquina de estados + traza | ✅ verificado |
| **1b** | Async: cola, reaper por latido, presupuestos, DLQ — [spec 002](docs/specs/002-ejecucion-asincrona.md) | ✅ verificado |
| **—** | Dashboard: tablero + traza en vivo | ✅ |
| **—** | Rescate del workspace + limpieza de containers huérfanos | ✅ verificado |
| **—** | Tests (140) + 13 ADRs + 5 specs | ✅ |
| 2 | Ramas y pull requests — [spec 003](docs/specs/003-pull-requests.md) | 🟡 implementada, falta verificación real |
| 3 | Gates de calidad — [spec 004](docs/specs/004-gates-de-calidad.md) | 🟡 implementada, falta verificación real |
| 4 | Multiagente: Tech Lead → Developer / Reviewer / QA | ⬜ |
| 5 | Rúbricas = criterios de aceptación ejecutables | ⬜ |
| 6 | Despliegue — [spec 005](docs/specs/005-despliegue.md) | 📄 especificada |

📄 = diseñada y documentada con criterio de aceptación, sin implementar.
🟡 = implementada y verificada contra dobles (incluido el webhook con firmas
HMAC reales sobre HTTP); falta la corrida de punta a punta contra un repo de
GitHub. Ver [Verificación real](#verificación-real-fases-2-y-3).

## Arranque

Requiere **Docker Desktop corriendo** y Node 22+.

```bash
npm install
npm test             # 140 tests — sin base, sin Docker, sin Redis, sin LLM, sin GitHub
npm run smoke        # verifica el sandbox — no necesita ninguna key

cp .env.example .env # completar LLM_API_KEY
npm run models       # lista los modelos que tu key habilita

# Agente suelto, sin persistencia
npm run run
npm run run "tu tarea acá"
```

### Plataforma completa

Postgres (5433) y Redis (6380) usan puertos corridos para no chocar con
instancias locales. Los volúmenes sobreviven a `db:down`.

```bash
npm run db:up        # Postgres + Redis en Docker
npm run db:migrate   # migraciones + regenera el cliente Prisma

# tres procesos, cada uno en su terminal
npm run api          # http://localhost:3000
npm run worker       # consume la cola, barre corridas muertas y sondea CI
                     # (exige GITHUB_TOKEN y GITHUB_REPO: entrega cada corrida como PR)
npm run dashboard    # http://localhost:4000  (npm run dashboard:install la 1ª vez)
```

El dashboard reescribe `/api/*` hacia `:3000`, así que no hay CORS y la API no
sabe que existe un frontend.

Sin worker corriendo, la API sigue aceptando tickets: quedan en `ASSIGNED`
esperando en la cola.

```bash
npm run dlq          # jobs que fallaron 3 veces: inspeccionar y reintentar
```

### API

```bash
# crear
curl -X POST localhost:3000/tickets -H "content-type: application/json" \
  -d '{"title":"Sumar","task":"Crea sum.mjs con tests y corré node --test"}'

# ejecutar (asíncrono: 202 y el worker se encarga)
curl -X POST localhost:3000/tickets/<id>/run
# → { "ticketId": "...", "jobId": "..." }

# consultar
curl localhost:3000/tickets
curl localhost:3000/tickets?status=DONE
curl localhost:3000/tickets/<id>/runs
curl "localhost:3000/tickets/<id>/runs/<runId>/events?after=0"

# el codigo que el agente escribio, rescatado antes de destruir el container
curl localhost:3000/tickets/<id>/runs/<runId>/artifact

# el PR fallo pero el push salio: reintenta sin reejecutar al agente
curl -X POST localhost:3000/tickets/<id>/pull-request

# evaluar los checks del PR ya, sin esperar webhook ni poller
curl -X POST localhost:3000/tickets/<id>/gates
```

La traza es append-only: `?after=<último seq>` trae sólo lo nuevo. Encolar dos
veces el mismo ticket es idempotente (`jobId = ticketId`).

### Máquina de estados

```
BACKLOG → ASSIGNED → IN_PROGRESS → PR_OPEN → CHECKS_RUNNING → CHECKS_PASSED → DONE
             ↑   ↑         ↓          ↓            ↓
             │   └─────────┼──────────┼──── CHANGES_REQUESTED  (≤ 3 veces)
             │             ↓          ↓            ↓
             └────────── FAILED ◀─────┴────────────┘
```

Lista blanca de transiciones: todo lo que no esté declarado está prohibido.
Ejecutar un ticket que ya está en `DONE` devuelve `409`.

**No existe `IN_PROGRESS → DONE`.** Una corrida completada termina en un PR, y
el único camino a DONE es `CHECKS_PASSED`, que escribe la evaluación de los
checks de CI ([ADR 0013](docs/adr/0013-el-veredicto-de-los-gates-vive-en-el-dominio.md)).
Un rechazo vuelve a `ASSIGNED` con lo que falló agregado al task, y el agente
reintenta sobre la misma rama: el PR se actualiza solo.

`ASSIGNED` significa "en la cola"; `IN_PROGRESS`, "un worker lo tomó y está
latiendo". El claim lo hace el worker, no la API, para que el estado no mienta.
Si el worker muere, el reaper cierra la corrida en ≤ 2 min con
`outcome: 'abandoned'` y el ticket vuelve a `FAILED`, desde donde se reintenta.

La key por defecto es de **Groq** (free tier, sin tarjeta):
[console.groq.com/keys](https://console.groq.com/keys). Cualquier proveedor
compatible con OpenAI sirve — ver `.env.example`.

## Verificación real (fases 2 y 3)

Las fases 2 y 3 están verificadas contra dobles. Falta la corrida de punta a
punta contra GitHub, que necesita un repo de prueba y un token.

**Estado al 2026-11-07: infra verificada, GitHub pendiente.** Contra Docker
real: Postgres y Redis del compose arriba, las dos migraciones que faltaban
(`rescate_del_workspace` y `pull_requests_y_gates`) aplicadas con
`prisma migrate deploy`, 140 tests y `typecheck` en verde. La API arranca sin
token, crea tickets con las columnas nuevas (`branch`, `prNumber`,
`gateAttempts`…) y responde 503 en `/tickets/:id/pull-request` y
`/webhooks/github`; el worker se niega a arrancar. Los pasos 4 a 7 **no se
corrieron**: `.env` todavía no tiene `GITHUB_TOKEN` ni `GITHUB_REPO` reales
(quedaron los placeholders de `.env.example`). La key del LLM sí está.

1. **Repo de prueba.** Crear uno en GitHub (privado sirve) con al menos un
   commit en `main` y un workflow de Actions que corra los tests, por ejemplo
   `.github/workflows/ci.yml` con un job `test` que haga `node --test`.
2. **Token.** PAT fine-grained **sólo sobre ese repo**: Contents y Pull
   requests en *Read and write*, Checks en *Read-only*. Cargarlo en `.env` como
   `GITHUB_TOKEN`, y el repo como `GITHUB_REPO=usuario/repo` (ver
   `.env.example`). Nunca pegarlo en un chat ni en un commit.
3. **Levantar todo** (Docker Desktop corriendo):
   ```bash
   npm run db:up && npm run db:migrate   # aplica la migración de esta fase
   npm run api      # terminal 1
   npm run worker   # terminal 2: imprime "repo: usuario/repo"
   ```
4. **Camino verde.** Crear un ticket que pida algo con tests que pasen y
   correrlo. Esperado: `IN_PROGRESS → PR_OPEN` con el PR visible en GitHub
   (cuerpo armado desde la traza), y en ≤ 60 s después de que termine CI,
   `DONE`.
5. **Camino rojo.** Un ticket cuyo test no pueda pasar. Esperado:
   `CHANGES_REQUESTED → ASSIGNED`, una segunda corrida con el feedback en el
   prompt, un segundo commit en **la misma** rama, y al tercer rechazo `FAILED`
   con `status_reason = gates_exhausted`.
6. **Webhook (opcional).** Exponer la API (por ejemplo con un túnel), crear el
   webhook del repo con eventos *Check suites* y *Check runs*, y poner el
   mismo secreto en `GITHUB_WEBHOOK_SECRET`. Con el webhook el DONE llega en
   segundos; sin él, el poller lo trae en ≤ 60 s.
7. **Secretos.** Con el ticket cerrado:
   `SELECT count(*) FROM agent_events WHERE payload::text LIKE '%github_pat_%';`
   tiene que dar 0.

## Costo

US$0 con free tier. Docker corre local.

El límite que muerde en un loop agéntico no es el de tokens sino el de
**requests por minuto**: cada tarea dispara una llamada por iteración.

## Tests

```bash
npm test        # 140 tests, ~1 s
```

Corren **sin base de datos, sin Docker, sin Redis y sin LLM**: la lógica de orquestación se
verifica contra dobles de prueba. Ese es el retorno concreto de la arquitectura
hexagonal, y la razón por la que los puertos valen su indirección.

- `src/domain/ticket.test.ts` — la máquina de estados, verificada de forma
  exhaustiva sobre todo el producto cartesiano de estados.
- `src/application/run-ticket.use-case.test.ts` — la orquestación: carreras
  entre workers, fallos del LLM, limpieza del sandbox, tolerancia del log.
- `src/application/enqueue-ticket.use-case.test.ts` — qué estados se pueden
  encolar, e idempotencia.
- `src/application/reap-stale-runs.use-case.test.ts` — el umbral de latido.
- `src/domain/agent-runner.test.ts` — los tres presupuestos y cuál corta primero.
- `src/application/sweep-orphan-sandboxes.use-case.test.ts` — qué container es
  basura y cuál está trabajando.
- `src/domain/quality-gates.test.ts` — qué es "pasar los gates": rojos,
  pendientes, no bloqueantes, y que cero checks no sea verde.
- `src/application/open-pull-request.use-case.test.ts` — rama con sufijo,
  reintento del PR sin reejecutar, scope faltante, y que el PAT no se filtre.
- `src/application/evaluate-gates.use-case.test.ts` — DONE, rechazo con
  feedback, timeout de 30 min, tope de 3, poller sin webhook.
- `src/infrastructure/github/*.test.ts` — el contrato con la API de GitHub
  sobre un `fetch` falso, y la firma HMAC del webhook.
- `src/infrastructure/sandbox/docker.sandbox.test.ts` — la extracción del
  workspace: rutas con comillas, espacios, acentos y saltos de línea; binarios;
  y que un patrón de exclusión no pueda inyectar shell. Son funciones puras, así
  que tampoco necesitan Docker.

## Documentación

Las decisiones y el comportamiento están en **[`docs/`](docs/README.md)**:

- **[ADR](docs/README.md#decisiones-adr)** — por qué cada cosa es como es.
  Arquitectura hexagonal, proveedor agnóstico, el sandbox como única frontera,
  lista blanca de transiciones, compare-and-set, traza append-only, por qué
  el veredicto no lo da el agente, por qué la vida de una corrida se mide con
  latidos y no con relojes, por qué la API no ejecuta agentes, por qué git corre
  fuera del sandbox, por qué el container lleva el id de su corrida, por qué
  los PRs se arman sin clonar y por qué el veredicto de los gates vive en el
  dominio.
- **[Specs](docs/README.md#comportamiento-spec)** — qué tiene que pasar, esté
  implementado o no. Incluye el diseño completo de PRs, gates de calidad y
  despliegue, que todavía no están construidos.

Si vas a implementar la fase siguiente, la spec correspondiente tiene el
criterio de aceptación al final.

**El deploy no se le da al agente.** Es difícil de revertir: lo dispara la
máquina de estados cuando pasan los gates.

## Notas

- `reference/managed-agents/` tiene la implementación sobre Managed Agents de
  Anthropic (Anthropic hostea el loop y el sandbox, con multiagente y rúbricas
  built-in). Requiere API key con facturación propia. Para usarla:
  `npm i @anthropic-ai/sdk`.
- Si hay que portar a Python/FastAPI, los puertos son los mismos: cambian los
  adapters, no el dominio.
