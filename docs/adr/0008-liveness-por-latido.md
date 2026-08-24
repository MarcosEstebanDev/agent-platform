# ADR 0008 — La vida de una corrida se mide con latidos, no con relojes

**Estado:** Aceptada · 2026-08-23

## Contexto

Cuando la ejecución pasa a ser asíncrona ([spec 002](../specs/002-ejecucion-asincrona.md)),
aparece una falla que antes no existía: el worker puede morir a mitad de corrida.
El proceso se cae, la máquina se apaga, el container se queda sin memoria. Nadie
escribe el estado final.

El ticket queda en `IN_PROGRESS` para siempre. No es un error transitorio: es un
estado inconsistente permanente, y encima invisible — el sistema se ve sano, con
un ticket "trabajando" que nadie está trabajando.

La respuesta intuitiva es un timeout: si la corrida arrancó hace más de N minutos,
darla por muerta. El problema es elegir N. Una corrida legítima con un modelo lento
y 25 iteraciones puede durar mucho, y `npm install` dentro del sandbox agrega
minutos impredecibles. Un N chico mata trabajo válido; un N grande deja tickets
colgados durante ese N. No hay valor bueno, porque el timeout mide **cuánto pasó**,
que es la pregunta equivocada.

## Decisión

El worker escribe `agent_runs.heartbeat_at` cada 30 s mientras corre. Un barrido
periódico busca corridas sin terminar cuyo último latido esté vencido y las cierra
con `outcome: 'abandoned'`, devolviendo el ticket a `FAILED`:

```sql
SELECT id FROM agent_runs
WHERE finished_at IS NULL
  AND heartbeat_at < now() - interval '90 seconds'
```

Lo que distingue "trabajando" de "muerto" no es cuánto tiempo pasó, sino si
**alguien sigue reportando**. Una corrida de 40 minutos que late está viva; una de
2 minutos que dejó de latir está muerta.

Los dos números no son independientes, y ninguno de los dos es arbitrario:

- **Umbral = 90 s = 3 latidos perdidos.** Tiene que ser mayor al doble del intervalo
  de latido. Con un umbral de 60 s, un latido demorado por GC o por una base lenta
  alcanza para que el reaper mate una corrida viva.
- **Barrido = 30 s.** El peor caso de detección es `umbral + intervalo`, no el
  umbral: una corrida que muere justo después de un barrido espera al siguiente.
  90 + 30 = 2 min, que es lo que promete la spec.

Ese último punto se pagó caro: la spec original pedía detectar en ≤ 2 min pero
proponía barrer cada 5 min con umbral de 2, lo que da un peor caso de 7 min. **La
spec hacía imposible su propio criterio de aceptación**, y el error era invisible
leyendo cada número por separado.

El presupuesto de tiempo (`maxWallClockMs`) sigue existiendo, pero responde otra
pregunta: no "¿sigue vivo?" sino "¿vale la pena seguir gastando?". Un agente
enroscado late perfectamente mientras quema tokens. Liveness y presupuesto son
mecanismos distintos porque son fallas distintas.

## Consecuencias

**A favor**

- No hay que elegir una duración máxima de corrida. Corridas largas legítimas y
  workers muertos se distinguen solos.
- El reaper es un `UPDATE` con `WHERE`: no coordina con nadie, no necesita saber
  qué workers existen, y correr dos reapers a la vez es inofensivo.
- La detección tiene una cota demostrable (2 min) en vez de depender de qué tan
  rápido sea la tarea.

**En contra**

- Cada corrida escribe en la base cada 30 s aunque no pase nada. Es tráfico
  constante proporcional a la concurrencia, no al trabajo real.
- Una pausa larga del proceso (GC, swap, la máquina suspendida) se ve idéntica a
  una muerte. El worker resucitado sigue creyendo que la corrida es suya, y va a
  escribir el resultado de una corrida ya cerrada. Hoy eso no rompe nada porque la
  escritura final es un compare-and-set sobre el estado del ticket
  ([ADR 0005](0005-claim-por-compare-and-set.md)), pero es una carrera que existe.
- **El reaper limpia la base, no Docker.** El container del worker muerto sigue
  vivo, porque `sandbox.stop()` nunca corrió. Hay que borrarlos a mano
  (`docker rm -f agent-sbx-*`). Deuda registrada en la spec 002.

## Notas

`FAILED` es el estado terminal de una corrida abandonada, no `BACKLOG`. La
diferencia importa: `FAILED` conserva la traza de lo que llegó a pasar, y deja la
decisión de reintentar en manos de una persona. Un reintento automático haría que
una falla determinística (por ejemplo, un sandbox que no arranca) gire para siempre.

Para que eso fuera cierto hubo que agregar la transición `FAILED → ASSIGNED`: la
spec prometía "desde donde se puede reintentar", pero el endpoint no aceptaba
`FAILED` y el estado era, en la práctica, un callejón sin salida.
