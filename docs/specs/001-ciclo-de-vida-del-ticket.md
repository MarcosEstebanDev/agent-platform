# Spec 001 — Ciclo de vida del ticket

**Fase:** 1 · **Estado:** Implementada

## Objetivo

Un ticket describe una unidad de trabajo. La plataforma lo ejecuta con un agente
en un entorno aislado, registra todo lo que hizo y lo lleva a un estado final.

## Modelo

| Entidad | Qué es |
|---|---|
| `Ticket` | La unidad de trabajo. Tiene `task`: la instrucción para el agente. |
| `AgentRun` | Una ejecución sobre un ticket. Un ticket puede tener varias. |
| `AgentEvent` | Un paso dentro de una corrida. Append-only, ordenado por `seq`. |

## Estados

```
BACKLOG ──▶ ASSIGNED ──▶ IN_PROGRESS ──┬──▶ DONE
              ▲   │                    │
              │   └──▶ BACKLOG         └──▶ FAILED
              │                              │
              └──────────────────────────────┘
```

`DONE` es terminal. `FAILED` vuelve a `ASSIGNED` para reintentar.
La política completa y su justificación: [ADR 0004](../adr/0004-maquina-de-estados-lista-blanca.md).

## Flujo de ejecución

```
1. Cargar el ticket                         → si no existe: not_found
2. Si está en BACKLOG, pasar a ASSIGNED     → si falla el CAS: already_taken
3. Verificar que esté en ASSIGNED           → si no: invalid_status
4. Tomarlo: ASSIGNED → IN_PROGRESS (CAS)    → si falla: already_taken
5. Abrir la corrida (AgentRun)
6. Crear un sandbox nuevo y arrancarlo
7. Correr el loop del agente
      · cada evento se persiste (best-effort)
8. Cerrar la corrida con el resumen         ← SIEMPRE, aunque 7 falle
9. Destruir el sandbox                      ← SIEMPRE, aunque 7 falle
10. IN_PROGRESS → DONE | FAILED
```

Los pasos 8 y 9 son incondicionales. **Un ticket colgado en `IN_PROGRESS` para
siempre es peor que uno fallado.**

## Contrato HTTP

| Método | Ruta | Respuesta |
|---|---|---|
| `POST` | `/tickets` | `201` con el ticket en `BACKLOG` |
| `GET` | `/tickets` | Lista. Filtro opcional `?status=` |
| `GET` | `/tickets/:id` | El ticket, o `404` |
| `POST` | `/tickets/:id/run` | El resultado, o `404` / `409` |

`POST /tickets` exige `title` y `task` no vacíos; si falta alguno, `400`.

`POST /tickets/:id/run` es **síncrono**: la request queda abierta hasta que el
agente termina. Aceptable con tareas cortas; la [spec 002](002-ejecucion-asincrona.md)
lo reemplaza.

Errores:

| Situación | Código |
|---|---|
| El ticket no existe | `404` |
| Está en un estado no ejecutable (`DONE`, `IN_PROGRESS`) | `409` |
| Otro worker se adelantó | `409` |

## Modos de falla

| Falla | Comportamiento |
|---|---|
| El proveedor de LLM devuelve error | `outcome: error`, ticket a `FAILED`, mensaje guardado |
| El agente agota `maxIterations` (25) | `outcome: max_iterations`, ticket a `FAILED` |
| Un comando falla dentro del sandbox | **No** rompe la corrida: el error vuelve al modelo como texto para que corrija |
| Falla el `INSERT` de un evento | Se ignora. Ver [ADR 0006](../adr/0006-traza-append-only.md) |
| El proceso muere a mitad de corrida | **Sin cubrir.** El ticket queda en `IN_PROGRESS`. Lo resuelve la [spec 002](002-ejecucion-asincrona.md) |

## Criterio de aceptación

- [x] Crear un ticket lo deja en `BACKLOG`.
- [x] Ejecutarlo lo lleva a `DONE` pasando por `ASSIGNED` e `IN_PROGRESS`.
- [x] Reejecutar un ticket en `DONE` devuelve `409`.
- [x] Un fallo del LLM deja el ticket en `FAILED`, nunca en `IN_PROGRESS`.
- [x] El sandbox se destruye también cuando la corrida falla.
- [x] Cada corrida usa un sandbox nuevo.
- [x] Los `seq` de los eventos son consecutivos desde 0.
- [x] Un fallo al persistir un evento no cambia el veredicto.

Verificado por `src/application/run-ticket.use-case.test.ts` y
`src/domain/ticket.test.ts` (20 tests, sin base ni Docker).

## Limitación declarada

Hoy `DONE` significa **"el agente terminó su turno sin errores"**, no "el código
funciona". Ver [ADR 0007](../adr/0007-el-veredicto-no-es-del-agente.md).
