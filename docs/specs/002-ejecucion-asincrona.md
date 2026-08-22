# Spec 002 — Ejecución asíncrona y recuperación

**Fase:** 1b · **Estado:** Especificada

## Objetivo

Desacoplar la petición de la ejecución, y garantizar que ningún ticket quede
colgado indefinidamente.

## Problemas que resuelve

| Problema hoy | Consecuencia |
|---|---|
| `POST /run` es síncrono | La request queda abierta minutos. Cualquier proxy la corta. |
| Sin reintentos | Un `502` del proveedor deja el ticket en `FAILED` para siempre. |
| Sin recuperación | Si el proceso muere a mitad de corrida, el ticket queda en `IN_PROGRESS` y nadie lo toca nunca más. |
| Sin límite de gasto | El único freno es `maxIterations`. Un agente enroscado puede correr 25 comandos de 2 minutos. |

El tercero es el más grave: es un estado inconsistente permanente, sin nadie que
lo observe.

## Diseño

```
POST /tickets/:id/run
      │
      ├─ BACKLOG → ASSIGNED (CAS)
      ├─ encola el job
      └─ 202 Accepted  { ticketId, jobId }

Worker (BullMQ)
      ├─ ASSIGNED → IN_PROGRESS (CAS)   ← el claim vive en el worker, no en la API
      ├─ ejecuta la corrida
      └─ IN_PROGRESS → DONE | FAILED

Reaper (cron, cada 5 min)
      └─ tickets en IN_PROGRESS con heartbeat vencido → FAILED
```

### Cola

- **BullMQ + Redis**, un job por corrida.
- `jobId = ticketId` para que encolar dos veces el mismo ticket sea idempotente.
- Backoff exponencial, 3 intentos, luego **DLQ**.
- Concurrencia configurable. Cada worker toma tickets distintos gracias al
  compare-and-set ([ADR 0005](../adr/0005-claim-por-compare-and-set.md)).

### Heartbeat y reaper

El worker actualiza `agent_runs.heartbeat_at` cada 30 s mientras corre. El
reaper busca:

```sql
SELECT id FROM agent_runs
WHERE finished_at IS NULL
  AND heartbeat_at < now() - interval '2 minutes'
```

y cierra esas corridas con `outcome: 'abandoned'`, devolviendo el ticket a
`FAILED` (desde donde se puede reintentar).

**Por qué heartbeat y no un timeout fijo:** una corrida legítima puede durar
mucho. Lo que distingue "trabajando" de "muerto" es si alguien sigue reportando,
no cuánto pasó.

### Presupuestos

Tres límites independientes, el que se agote primero corta:

| Límite | Default | Motivo |
|---|---|---|
| `maxIterations` | 25 | Ya existe |
| `maxWallClockMs` | 10 min | Un agente enroscado no corre para siempre |
| `maxTokens` | 100k | Techo de costo por corrida |

Al agotarse: `outcome: 'budget_exceeded'`, ticket a `FAILED`, y el motivo
registrado. **No** es un error del agente; es una decisión del orquestador.

### Cambios en el esquema

```prisma
model AgentRun {
  heartbeatAt DateTime? @map("heartbeat_at")
  // outcome suma: 'abandoned' | 'budget_exceeded'
}
```

## Contrato HTTP

| Método | Ruta | Respuesta |
|---|---|---|
| `POST` | `/tickets/:id/run` | `202` con `{ ticketId, jobId }` |
| `GET` | `/tickets/:id/runs` | Corridas del ticket con su estado |
| `GET` | `/tickets/:id/runs/:runId/events` | Traza paginada |

Para seguir el progreso en vivo, `GET /tickets/:id/stream` (SSE) reemitiendo los
`AgentEvent`. Opcional; el polling sobre `/runs` alcanza al principio.

## Modos de falla

| Falla | Comportamiento |
|---|---|
| Redis caído | `POST /run` devuelve `503`. No se pierde el ticket: sigue en `ASSIGNED`. |
| Worker muere a mitad | El reaper lo cierra en ≤ 2 min y el ticket vuelve a `FAILED`. |
| Job falla 3 veces | Va a la DLQ. El ticket queda en `FAILED` con el último error. |
| Se encola dos veces | Idempotente por `jobId`. |

## Criterio de aceptación

- [ ] `POST /run` responde `202` en menos de 100 ms.
- [ ] Con dos workers y un ticket, exactamente uno lo ejecuta.
- [ ] Matar el worker a mitad de corrida deja el ticket en `FAILED` en ≤ 2 min,
      nunca en `IN_PROGRESS`.
- [ ] Un agente que supera el presupuesto de tiempo se corta con
      `outcome: 'budget_exceeded'`.
- [ ] Encolar el mismo ticket dos veces produce una sola corrida.
- [ ] Un job que falla 3 veces termina en la DLQ y es inspeccionable.
