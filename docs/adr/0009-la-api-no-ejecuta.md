# ADR 0009 — La API no ejecuta agentes, y el claim vive en el worker

**Estado:** Aceptada · 2026-08-23 · Refina [ADR 0005](0005-claim-por-compare-and-set.md)

## Contexto

Hasta la fase 1, `POST /tickets/:id/run` corría el agente dentro de la request:
levantaba el container, hablaba con el proveedor de LLM y respondía cuando todo
había terminado. Funcionaba, y era la forma más simple de cerrar el ciclo.

Sus costos aparecen todos juntos apenas hay más de un usuario:

- La request queda abierta minutos. Cualquier proxy intermedio la corta antes.
- El proceso que atiende HTTP es el mismo que gasta CPU, memoria y tokens. Un
  agente enroscado degrada el listado de tickets.
- La API no arranca sin API key ni sin Docker, aunque el 90% de sus rutas sean
  lecturas que no necesitan ninguna de las dos cosas.
- Escalar la ejecución obliga a escalar el HTTP, y al revés.

## Decisión

**La API valida, persiste y encola. Nada más.** El trabajo pesado vive en
`src/worker/main.ts`, un proceso aparte con su propio composition root.

`POST /tickets/:id/run` hace `BACKLOG|ASSIGNED|FAILED → ASSIGNED` y encola;
responde `202` con `{ ticketId, jobId }`. El composition root de la API
(`src/api/app.module.ts`) no importa el adapter de LLM ni el de sandbox: la API
arranca sin `LLM_API_KEY` y sin Docker corriendo.

La parte no obvia es **dónde se toma el ticket**. Lo natural sería que la API
hiciera `ASSIGNED → IN_PROGRESS` al encolar, pero eso miente: un ticket encolado
que nadie procesa todavía —porque no hay workers, o están todos ocupados— quedaría
`IN_PROGRESS` sin nadie corriendo, que es exactamente el estado inconsistente que
la fase 1b vino a eliminar.

Así que el claim es lo primero que hace el worker, con el compare-and-set del
[ADR 0005](0005-claim-por-compare-and-set.md). El estado del ticket describe la
realidad y no una intención:

| Estado | Significa |
|---|---|
| `ASSIGNED` | Está en la cola. Nadie lo tomó todavía. |
| `IN_PROGRESS` | Un worker concreto lo tomó y está latiendo. |

Corolario: `IN_PROGRESS` siempre tiene un latido asociado, y por eso el reaper del
[ADR 0008](0008-liveness-por-latido.md) puede tratar la ausencia de latido como
prueba de muerte. Si la API hiciera el claim, habría `IN_PROGRESS` legítimos sin
latido y el reaper no tendría cómo distinguirlos de los abandonados.

## Consecuencias

**A favor**

- API y ejecución escalan por separado. Los workers son ganado: se agregan y se
  matan sin tocar el HTTP.
- La API se puede desplegar donde no hay Docker.
- Un agente enroscado o un proveedor caído no afectan la lectura del tablero.
- El estado del ticket no miente, lo que habilita el reaper.

**En contra**

- Hay dos composition roots y dos procesos que levantar. El arranque local pasó
  de un comando a tres (`api`, `worker`, `dashboard`), más la infra.
- La respuesta ya no trae el resultado: el cliente tiene que seguir la traza.
  El dashboard hace polling incremental (`?after=<seq>`).
- Redis pasa a ser dependencia dura de `POST /run`. Sin Redis devuelve `503`,
  aunque el ticket no se pierde: queda en `ASSIGNED` y se puede reencolar.
- Un ticket puede quedar en `ASSIGNED` indefinidamente si nunca hay un worker.
  Es visible y honesto, pero nadie lo vigila todavía.

## Notas

El límite se puede verificar de una forma barata, y conviene que siga siendo
cierta: **la API arranca con `LLM_API_KEY` vacía y con Docker apagado**. Si algún
día deja de arrancar, alguien volvió a meter el sandbox o el proveedor en el
proceso HTTP.
