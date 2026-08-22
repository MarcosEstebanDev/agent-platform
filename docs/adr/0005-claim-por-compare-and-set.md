# ADR 0005 — Tomar un ticket es un compare-and-set

**Estado:** Aceptada · 2026-08-22

## Contexto

La fase 1b introduce varios workers consumiendo la misma cola. Dos workers
pueden intentar tomar el mismo ticket en el mismo instante.

La forma intuitiva de escribirlo tiene una carrera:

```ts
const ticket = await repo.findById(id);        // ambos leen ASSIGNED
if (ticket.status !== 'ASSIGNED') return;      // ambos pasan el chequeo
await repo.update(id, { status: 'IN_PROGRESS' }); // ambos ejecutan
```

La ventana entre el `SELECT` y el `UPDATE` es chica pero real. El resultado son
dos agentes trabajando el mismo ticket en containers distintos: doble gasto de
tokens, dos ramas, dos PRs, y una traza donde los eventos de dos corridas se
mezclan.

## Decisión

La condición y la escritura viajan en **una sola sentencia SQL**. El estado
esperado va en el `WHERE`:

```sql
UPDATE tickets SET status = $3 WHERE id = $1 AND status = $2
```

El repositorio devuelve el ticket si afectó una fila, y `null` si afectó cero.
`null` significa "otro se adelantó" — no es un error, es información:

```ts
const claimed = await tickets.transition(id, 'ASSIGNED', 'IN_PROGRESS');
if (!claimed) return { ok: false, reason: 'already_taken' };
```

El caso de uso nunca hace `findById` seguido de `update` para cambiar estado.

## Consecuencias

**A favor**

- La exclusión mutua la garantiza el motor de base, sin locks aplicativos ni
  coordinación entre workers.
- Escala a N workers sin cambios.
- El perdedor de la carrera se entera de inmediato y sin excepción.

**En contra**

- Requiere dos viajes a la base para devolver el ticket actualizado: el `UPDATE`
  y luego un `SELECT`. Aceptable — no está en un camino caliente.
- El contrato es fácil de romper por descuido: alguien puede agregar un método
  que actualice el estado sin la condición. Los tests del caso de uso cubren
  el escenario de carrera, pero no impiden que se agregue otro camino.

## Notas

El doble de prueba (`FakeTicketRepository`) implementa la misma semántica:
devuelve `null` si el estado no coincide, y además llama a `assertTransition`.
Si el caso de uso intentara una transición ilegal, el test falla ahí — no en
producción.
