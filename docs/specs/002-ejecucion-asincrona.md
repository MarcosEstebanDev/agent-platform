# Spec 002 — Ejecución asíncrona y recuperación

**Fase:** 1b · **Estado:** Implementada (commit `36aafe8`, verificada contra infra real el 2026-08-23)

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

Reaper (cron, cada 30 s)
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
  AND heartbeat_at < now() - interval '90 seconds'
```

y cierra esas corridas con `outcome: 'abandoned'`, devolviendo el ticket a
`FAILED` (desde donde se puede reintentar).

**Por qué heartbeat y no un timeout fijo:** una corrida legítima puede durar
mucho. Lo que distingue "trabajando" de "muerto" es si alguien sigue reportando,
no cuánto pasó.

**Corrección al implementar — el peor caso es (umbral + intervalo), no el umbral.**
Esta spec pedía originalmente barrer cada 5 min con un umbral de 2 min. Una corrida
que muere justo después de un barrido no se detecta hasta el barrido siguiente, así
que el peor caso era 7 min: la spec hacía imposible su propio criterio de aceptación
de "≤ 2 min". Corregido a **30 s de barrido / 90 s de umbral** (= 3 latidos perdidos),
lo que da un peor caso de 2 min exactos. El umbral tiene que ser mayor al doble del
intervalo de latido, o el reaper cierra corridas vivas.

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

Verificado el 2026-08-23 con 11 corridas reales contra Groq (costo US$0).

- [x] `POST /run` responde `202` en menos de 100 ms.
      → **18 ms** en caliente (699 ms la primera, por la conexión fría a Redis).
- [x] Con dos workers y un ticket, exactamente uno lo ejecuta.
- [x] Matar el worker a mitad de corrida deja el ticket en `FAILED` en ≤ 2 min,
      nunca en `IN_PROGRESS`. → **121 s**, con `outcome: 'abandoned'`.
- [x] Un agente que supera el presupuesto de tiempo se corta con
      `outcome: 'budget_exceeded'` y motivo `wall_clock`.
- [x] Encolar el mismo ticket dos veces produce una sola corrida.
- [x] Un job que falla 3 veces termina en la DLQ y es inspeccionable
      (`npm run dlq`), y al rescatarlo con retry llega a `DONE`.

## Desviaciones respecto del diseño original

| Punto de la spec | Qué pasó al implementar |
|---|---|
| Reaper cada 5 min, umbral 2 min | Corregido a 30 s / 90 s (ver arriba). |
| `GET /tickets/:id/stream` (SSE) | **No implementado.** El dashboard sigue la traza con polling incremental sobre `/runs/:runId/events?after=<seq>`, que es append-only y no repite lo ya leído. SSE no aporta lo suficiente todavía para justificar una conexión abierta por espectador. |
| `POST /run` acepta BACKLOG y ASSIGNED | Suma **FAILED**. Sin eso, el `FAILED` que escribe el reaper era un callejón sin salida: la spec prometía "desde donde se puede reintentar" pero no existía la transición. |
| Presupuesto de tiempo dentro del loop | El reloj arranca **antes** de `sandbox.start()`. Levantar el container tarda segundos, o minutos si tiene que bajar la imagen; con el reloj adentro del loop la misma tarea daba `completed` en vez de `budget_exceeded`. |

## Deuda conocida (no bloquea esta spec)

1. ~~**Containers huérfanos.**~~ **Resuelto el 2026-08-24.** El container lleva el
   id de su corrida como label, y un segundo barrido destruye aquellos cuya corrida
   la base da por cerrada. Ver [ADR 0011](../adr/0011-identidad-del-container.md).
2. **Contabilidad perdida en excepciones.** Si la corrida explota, `iterations` y
   `tokens` se persisten en 0 aunque se hayan gastado.
3. **Un tool call malformado mata la corrida.** El proveedor devuelve 400
   `tool_use_failed` cuando el modelo emite mal los argumentos, y ese error no
   vuelve al modelo para que corrija, a diferencia de los errores de tool normales.
