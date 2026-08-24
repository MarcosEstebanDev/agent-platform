# agent-platform

Plataforma de orquestación de agentes de desarrollo: un agente coordinador
organiza tickets, delega implementación, y el ciclo cierra con PR, tests y deploy.

**Agnóstica del proveedor.** El dominio no sabe qué LLM ni qué sandbox hay
debajo — eso vive en adapters intercambiables.

## Arquitectura

```
src/
├── domain/                    ← puro, sin frameworks ni SDKs
│   ├── ports/
│   │   ├── llm.port.ts        "completá con estas tools"
│   │   ├── sandbox.port.ts    "ejecutá esto de forma aislada"
│   │   ├── queue.port.ts      "encolá esta corrida"
│   │   └── ticket-repository.port.ts
│   ├── agent-runner.ts        el loop del agente + presupuestos
│   └── ticket.ts              máquina de estados (lista blanca de transiciones)
├── application/
│   ├── enqueue-ticket.use-case.ts   valida, marca ASSIGNED y encola
│   ├── run-ticket.use-case.ts       claim → agente → traza → veredicto
│   ├── reap-stale-runs.use-case.ts  cierra corridas sin latido
│   └── fakes.ts                     dobles de prueba compartidos
├── infrastructure/
│   ├── llm/openai-compatible.adapter.ts   cualquier proveedor OpenAI-compatible
│   ├── queue/bullmq-queue.adapter.ts      BullMQ + Redis
│   ├── persistence/                       Prisma 7 (driver adapter)
│   └── sandbox/                           Docker local, un container por corrida
├── api/                       NestJS: encola y consulta. NO ejecuta agentes.
├── worker/                    consume la cola, corre el agente, late y barre
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

## Estado

| Fase | Qué | Estado |
|---|---|---|
| **0a** | Sandbox Docker aislado, con exec / write / read | ✅ verificado |
| **0b** | Loop de agente cerrando una tarea end-to-end | ✅ verificado |
| **1** | Orquestador NestJS: ticket + máquina de estados + traza | ✅ verificado |
| **1b** | Async: cola, reaper por latido, presupuestos, DLQ — [spec 002](docs/specs/002-ejecucion-asincrona.md) | ✅ verificado |
| **—** | Dashboard: tablero + traza en vivo | ✅ |
| **—** | Tests (44) + 9 ADRs + 5 specs | ✅ |
| 2 | Ramas y pull requests — [spec 003](docs/specs/003-pull-requests.md) | 📄 especificada |
| 3 | Gates de calidad — [spec 004](docs/specs/004-gates-de-calidad.md) | 📄 especificada |
| 4 | Multiagente: Tech Lead → Developer / Reviewer / QA | ⬜ |
| 5 | Rúbricas = criterios de aceptación ejecutables | ⬜ |
| 6 | Despliegue — [spec 005](docs/specs/005-despliegue.md) | 📄 especificada |

📄 = diseñada y documentada con criterio de aceptación, sin implementar.

## Arranque

Requiere **Docker Desktop corriendo** y Node 22+.

```bash
npm install
npm test             # 44 tests — sin base, sin Docker, sin Redis, sin LLM
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
npm run worker       # consume la cola y barre corridas muertas
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
```

La traza es append-only: `?after=<último seq>` trae sólo lo nuevo. Encolar dos
veces el mismo ticket es idempotente (`jobId = ticketId`).

### Máquina de estados

```
BACKLOG → ASSIGNED → IN_PROGRESS → DONE
             ↑            ↓
             └───────── FAILED
```

Lista blanca de transiciones: todo lo que no esté declarado está prohibido.
Ejecutar un ticket que ya está en `DONE` devuelve `409`.

`ASSIGNED` significa "en la cola"; `IN_PROGRESS`, "un worker lo tomó y está
latiendo". El claim lo hace el worker, no la API, para que el estado no mienta.
Si el worker muere, el reaper cierra la corrida en ≤ 2 min con
`outcome: 'abandoned'` y el ticket vuelve a `FAILED`, desde donde se reintenta.

La key por defecto es de **Groq** (free tier, sin tarjeta):
[console.groq.com/keys](https://console.groq.com/keys). Cualquier proveedor
compatible con OpenAI sirve — ver `.env.example`.

## Costo

US$0 con free tier. Docker corre local.

El límite que muerde en un loop agéntico no es el de tokens sino el de
**requests por minuto**: cada tarea dispara una llamada por iteración.

## Tests

```bash
npm test        # 44 tests, ~1.7 s
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

## Documentación

Las decisiones y el comportamiento están en **[`docs/`](docs/README.md)**:

- **[ADR](docs/README.md#decisiones-adr)** — por qué cada cosa es como es.
  Arquitectura hexagonal, proveedor agnóstico, el sandbox como única frontera,
  lista blanca de transiciones, compare-and-set, traza append-only, por qué
  el veredicto no lo da el agente, por qué la vida de una corrida se mide con
  latidos y no con relojes, y por qué la API no ejecuta agentes.
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
