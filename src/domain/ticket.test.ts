import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
  type TicketStatus,
} from './ticket.js';

const ALL: TicketStatus[] = ['BACKLOG', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'FAILED'];

/**
 * Toda transición que la plataforma permite, declarada una sola vez.
 * Cualquier par que no esté acá debe estar prohibido — eso se verifica
 * de forma exhaustiva más abajo, no caso por caso.
 */
const PERMITIDAS: ReadonlyArray<[TicketStatus, TicketStatus]> = [
  ['BACKLOG', 'ASSIGNED'],
  ['ASSIGNED', 'IN_PROGRESS'],
  ['ASSIGNED', 'BACKLOG'],
  ['IN_PROGRESS', 'DONE'],
  ['IN_PROGRESS', 'FAILED'],
  ['FAILED', 'ASSIGNED'],
];

test('permite exactamente las transiciones declaradas', () => {
  for (const [from, to] of PERMITIDAS) {
    assert.equal(canTransition(from, to), true, `${from} → ${to} debería permitirse`);
  }
});

test('prohíbe TODO el resto del producto cartesiano', () => {
  const permitidas = new Set(PERMITIDAS.map(([f, t]) => `${f}→${t}`));

  for (const from of ALL) {
    for (const to of ALL) {
      if (permitidas.has(`${from}→${to}`)) continue;
      assert.equal(
        canTransition(from, to),
        false,
        `${from} → ${to} NO debería permitirse`,
      );
    }
  }
});

test('ningún estado transiciona a sí mismo', () => {
  for (const s of ALL) {
    assert.equal(canTransition(s, s), false, `${s} → ${s} no debería permitirse`);
  }
});

test('DONE es terminal: nada sale de ahí', () => {
  assert.equal(isTerminal('DONE'), true);
  for (const to of ALL) {
    assert.equal(canTransition('DONE', to), false);
  }
});

test('FAILED NO es terminal: se puede reintentar vía ASSIGNED', () => {
  assert.equal(isTerminal('FAILED'), false);
  assert.equal(canTransition('FAILED', 'ASSIGNED'), true);
});

test('no se puede saltear ASSIGNED yendo de BACKLOG a IN_PROGRESS', () => {
  assert.equal(canTransition('BACKLOG', 'IN_PROGRESS'), false);
});

test('un ticket terminado no se puede reabrir', () => {
  assert.equal(canTransition('DONE', 'IN_PROGRESS'), false);
  assert.equal(canTransition('DONE', 'ASSIGNED'), false);
});

test('assertTransition lanza InvalidTransitionError con from/to legibles', () => {
  assert.throws(
    () => assertTransition('DONE', 'IN_PROGRESS'),
    (err: unknown) => {
      assert.ok(err instanceof InvalidTransitionError);
      assert.equal(err.from, 'DONE');
      assert.equal(err.to, 'IN_PROGRESS');
      assert.match(err.message, /DONE/);
      return true;
    },
  );
});

test('assertTransition no lanza cuando la transición es válida', () => {
  assert.doesNotThrow(() => assertTransition('BACKLOG', 'ASSIGNED'));
});

test('todo estado no terminal tiene al menos una salida', () => {
  for (const s of ALL) {
    if (isTerminal(s)) continue;
    const salidas = ALL.filter((to) => canTransition(s, to));
    assert.ok(salidas.length > 0, `${s} no es terminal pero no tiene salidas`);
  }
});
