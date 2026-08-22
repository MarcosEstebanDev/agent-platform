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
│   │   └── sandbox.port.ts    "ejecutá esto de forma aislada"
│   └── agent-runner.ts        el loop del agente
│   ├── ticket.ts              máquina de estados (lista blanca de transiciones)
│   └── ports/
│       ├── ticket-repository.port.ts
│       └── sandbox-factory.port.ts
├── application/
│   └── run-ticket.use-case.ts  orquesta: claim → agente → traza → veredicto
├── infrastructure/
│   ├── llm/
│   │   └── openai-compatible.adapter.ts   cualquier proveedor OpenAI-compatible
│   ├── persistence/
│   │   ├── prisma-client.factory.ts       driver adapter (Prisma 7)
│   │   └── prisma-ticket.repository.ts
│   └── sandbox/
│       ├── docker.sandbox.ts              Docker local
│       └── docker-sandbox.factory.ts      un container por corrida
├── api/                       NestJS: controller + composition root
├── run.ts                     agente suelto, sin persistencia
├── models.ts                  lista los modelos que habilita tu API key
├── smoke.ts                   verifica el sandbox sin usar el LLM
└── db-smoke.ts                verifica la persistencia sin usar el LLM

reference/managed-agents/      Managed Agents de Anthropic (requiere API key)
```

Cambiar de proveedor es **cambiar tres líneas del `.env`**. El `agent-runner`
y el sandbox no se tocan.

## Estado

| Fase | Qué | Estado |
|---|---|---|
| **0a** | Sandbox Docker aislado, con exec / write / read | ✅ verificado |
| **0b** | Loop de agente cerrando una tarea end-to-end | ✅ verificado |
| **1** | Orquestador NestJS: ticket + máquina de estados + traza | ✅ verificado |
| **—** | Tests del dominio (20) + ADRs + specs | ✅ |
| 1b | Async, reintentos, reaper y presupuestos — [spec 002](docs/specs/002-ejecucion-asincrona.md) | 📄 especificada |
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
npm test             # 20 tests del dominio — sin base, sin Docker, sin LLM
npm run smoke        # verifica el sandbox — no necesita ninguna key

cp .env.example .env # completar LLM_API_KEY
npm run models       # lista los modelos que tu key habilita

# Agente suelto, sin persistencia
npm run run
npm run run "tu tarea acá"

# Plataforma completa
npm run db:up        # Postgres en Docker
npm run db:migrate   # migraciones + regenera el cliente Prisma
npm run api          # http://localhost:3000
```

### API

```bash
# crear
curl -X POST localhost:3000/tickets -H "content-type: application/json" \
  -d '{"title":"Sumar","task":"Crea sum.mjs con tests y corré node --test"}'

# ejecutar (síncrono: espera a que el agente termine)
curl -X POST localhost:3000/tickets/<id>/run

# consultar
curl localhost:3000/tickets
curl localhost:3000/tickets?status=DONE
```

### Máquina de estados

```
BACKLOG → ASSIGNED → IN_PROGRESS → DONE
             ↑            ↓
             └───────── FAILED
```

Lista blanca de transiciones: todo lo que no esté declarado está prohibido.
Ejecutar un ticket que ya está en `DONE` devuelve `409`.

La key por defecto es de **Groq** (free tier, sin tarjeta):
[console.groq.com/keys](https://console.groq.com/keys). Cualquier proveedor
compatible con OpenAI sirve — ver `.env.example`.

## Costo

US$0 con free tier. Docker corre local.

El límite que muerde en un loop agéntico no es el de tokens sino el de
**requests por minuto**: cada tarea dispara una llamada por iteración.

## Tests

```bash
npm test        # 20 tests, ~700 ms
```

Corren **sin base de datos, sin Docker y sin LLM**: la lógica de orquestación se
verifica contra dobles de prueba. Ese es el retorno concreto de la arquitectura
hexagonal, y la razón por la que los puertos valen su indirección.

- `src/domain/ticket.test.ts` — la máquina de estados, verificada de forma
  exhaustiva sobre todo el producto cartesiano de estados.
- `src/application/run-ticket.use-case.test.ts` — la orquestación: carreras
  entre workers, fallos del LLM, limpieza del sandbox, tolerancia del log.

## Documentación

Las decisiones y el comportamiento están en **[`docs/`](docs/README.md)**:

- **[ADR](docs/README.md#decisiones-adr)** — por qué cada cosa es como es.
  Arquitectura hexagonal, proveedor agnóstico, el sandbox como única frontera,
  lista blanca de transiciones, compare-and-set, traza append-only, y por qué
  el veredicto no lo da el agente.
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
