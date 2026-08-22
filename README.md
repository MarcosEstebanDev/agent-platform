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
| 1b | BullMQ: ejecución asíncrona con reintentos y DLQ | ⬜ |
| 2 | Rama por ticket + PR | ⬜ |
| 3 | Gate de CI antes del merge | ⬜ |
| 4 | Multiagente: Tech Lead → Developer / Reviewer / QA | ⬜ |
| 5 | Rúbricas = criterios de aceptación ejecutables | ⬜ |
| 6 | SonarCloud, Jira, deploy con aprobación humana | ⬜ |

## Arranque

Requiere **Docker Desktop corriendo** y Node 22+.

```bash
npm install
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

## Decisiones

**Puertos antes que adapters.** El `LlmPort` existe desde el primer día aunque
haya un solo adapter. No es sobreingeniería preventiva: durante la construcción
de este MVP, GitHub Models (el proveedor elegido originalmente) resultó estar
retirado desde el 30/07/2026 y devolvía `410`. Cambiar de proveedor costó un
archivo; el loop del agente y el sandbox no se tocaron.

**La base URL es un dato, no una constante.** Los proveedores gratis aparecen y
desaparecen. Por eso el adapter es genérico OpenAI-compatible y el proveedor
vive en el `.env`.

**El sandbox es la única frontera.** Todo lo que el agente ejecuta pasa por
`SandboxPort`. Nada corre en la shell del host: siempre `execFile` con args en
array, nunca interpolación de strings en un shell local.

**Defaults restrictivos.** El container arranca sin red (`--network none`),
con memoria y CPU acotadas y timeout por comando. Para `npm install` hay que
poner `SANDBOX_NETWORK=bridge` — explícitamente, entendiendo el riesgo.

**Los errores de tool no rompen el loop.** Se devuelven al modelo como texto
para que corrija el rumbo. Un `throw` mataría la corrida por un typo en un comando.

**El agente propone, la máquina de estados dispone.** Ninguna transición ocurre
porque el modelo diga que terminó: ocurre porque el orquestador la autorizó.
Hoy el veredicto todavía sale del autoreporte del agente (fase 1); desde la
fase 3 sale de los checks del PR — señal determinística.

**El claim del ticket es un compare-and-set.** `UPDATE ... WHERE id = $1 AND
status = $2` en una sola sentencia. Un `findById` seguido de `update` sería una
condición de carrera: dos workers podrían leer `ASSIGNED` a la vez y ambos
creerse dueños del ticket.

**La corrida se cierra siempre, aunque el agente explote.** Un ticket colgado
en `IN_PROGRESS` para siempre es peor que uno fallado.

**Persistir un evento no puede matar la corrida.** El log de auditoría es
best-effort: si falla el `INSERT`, el trabajo del agente sigue siendo válido.

**El deploy no se le da al agente.** Es difícil de revertir: lo dispara la
máquina de estados cuando pasan los gates.

## Notas

- `reference/managed-agents/` tiene la implementación sobre Managed Agents de
  Anthropic (Anthropic hostea el loop y el sandbox, con multiagente y rúbricas
  built-in). Requiere API key con facturación propia. Para usarla:
  `npm i @anthropic-ai/sdk`.
- Si hay que portar a Python/FastAPI, los puertos son los mismos: cambian los
  adapters, no el dominio.
