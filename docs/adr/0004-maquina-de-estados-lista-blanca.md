# ADR 0004 — Transiciones por lista blanca

**Estado:** Aceptada · 2026-08-22

## Contexto

Un ticket atraviesa varios estados y va a atravesar más: la fase 2 agrega
`PR_OPEN`, la fase 3 agrega `REVIEW` y `QA`. Cada estado nuevo multiplica los
pares posibles — con 5 estados hay 25 combinaciones; con 8, hay 64.

La mayoría de esas combinaciones son bugs: reabrir un ticket terminado, saltear
la revisión, volver a ejecutar algo que ya se desplegó.

Si el estado se cambia con asignaciones sueltas repartidas por el código
(`ticket.status = 'DONE'`), no hay un lugar donde leer qué es legal.

## Decisión

Una única tabla declarativa en el dominio, y **todo lo que no esté declarado
está prohibido**:

```ts
const ALLOWED: Record<TicketStatus, readonly TicketStatus[]> = {
  BACKLOG:     ['ASSIGNED'],
  ASSIGNED:    ['IN_PROGRESS', 'BACKLOG'],
  IN_PROGRESS: ['DONE', 'FAILED'],
  DONE:        [],
  FAILED:      ['ASSIGNED'],
};
```

Lista blanca, no lista negra: agregar un estado nuevo no abre transiciones por
omisión, las cierra. El default seguro es "prohibido".

Dos decisiones que merecen explicación:

- **`DONE` es terminal.** Un ticket terminado no se reabre; se crea uno nuevo.
  Reabrir haría ambigua la traza: ¿a qué corrida corresponde el resultado?
- **`FAILED` NO es terminal.** Vuelve a `ASSIGNED` para reintentar. Un fallo
  es casi siempre transitorio (el proveedor devolvió 502, el modelo se enroscó),
  y forzar a crear otro ticket perdería el historial de intentos.

## Consecuencias

**A favor**

- La política completa se lee en diez líneas.
- Es una función pura: se verifica de forma exhaustiva sobre todo el producto
  cartesiano de estados, no caso por caso.
- Agregar `PR_OPEN` es editar la tabla y correr los tests.

**En contra**

- Un cambio de flujo obliga a tocar el dominio. Es intencional: el flujo *es*
  el dominio.
- La tabla puede volverse difícil de leer con muchos estados. Si pasa de ~10,
  conviene un diagrama generado desde ella.

## Cumplimiento

`assertTransition` lanza `InvalidTransitionError`; el repositorio además hace
compare-and-set contra el estado esperado (ver
[0005](0005-claim-por-compare-and-set.md)). Son dos capas: el dominio decide
qué es legal, la base garantiza que nadie se saltee esa decisión por una carrera.
