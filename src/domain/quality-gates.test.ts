import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChecks, formatGateFeedback } from './quality-gates.js';
import type { CheckRun } from './ports/quality-gate.port.js';

function check(name: string, conclusion: CheckRun['conclusion'], summary?: string): CheckRun {
  return { name, status: 'completed', conclusion, summary };
}

function running(name: string): CheckRun {
  return { name, status: 'in_progress', conclusion: null };
}

// ─── Veredicto ──────────────────────────────────────────────────────────────

test('todos los checks en verde: passed', () => {
  const verdict = evaluateChecks([check('build', 'success'), check('test', 'success')]);
  assert.equal(verdict.state, 'passed');
});

test('un check en rojo alcanza para failed, aunque otros sigan corriendo', () => {
  // No tiene sentido esperar al resto: el PR ya no puede pasar, y cada minuto
  // de espera es un minuto que el agente no esta corrigiendo.
  const verdict = evaluateChecks([check('test', 'failure'), running('lint')]);
  assert.equal(verdict.state, 'failed');
  assert.deepEqual(verdict.failed.map((c) => c.name), ['test']);
});

test('alguno corriendo y ninguno en rojo: pending', () => {
  const verdict = evaluateChecks([check('build', 'success'), running('test')]);
  assert.equal(verdict.state, 'pending');
});

test('sin checks no hay DONE: pending, no passed', () => {
  // Criterio de la spec 004: ningun DONE sin al menos un check verde. Un repo
  // sin CI, o un PR cuyo CI todavia no arranco, se ven igual desde aca.
  assert.equal(evaluateChecks([]).state, 'pending');
});

test('solo checks salteados o neutrales no cuentan como verde', () => {
  const verdict = evaluateChecks([check('deploy', 'skipped'), check('info', 'neutral')]);
  assert.equal(verdict.state, 'pending');
});

test('cancelled, timed_out y action_required son rojos', () => {
  for (const conclusion of ['cancelled', 'timed_out', 'action_required'] as const) {
    assert.equal(evaluateChecks([check('ci', conclusion)]).state, 'failed', conclusion);
  }
});

test('un check no bloqueante en rojo no frena el PR, pero queda como advertencia', () => {
  const verdict = evaluateChecks(
    [check('test', 'success'), check('SonarCloud Code Analysis', 'failure')],
    { nonBlocking: ['SonarCloud Code Analysis'] },
  );
  assert.equal(verdict.state, 'passed');
  assert.deepEqual(verdict.warnings.map((c) => c.name), ['SonarCloud Code Analysis']);
});

test('un check no bloqueante corriendo no hace esperar', () => {
  const verdict = evaluateChecks(
    [check('test', 'success'), running('SonarCloud Code Analysis')],
    { nonBlocking: ['SonarCloud Code Analysis'] },
  );
  assert.equal(verdict.state, 'passed');
});

test('el verde de un check no bloqueante no alcanza para DONE', () => {
  // Si el unico verde es una advertencia, no hay ningun gate real que haya
  // aprobado el PR.
  const verdict = evaluateChecks([check('sonar', 'success')], { nonBlocking: ['sonar'] });
  assert.equal(verdict.state, 'pending');
});

// ─── Feedback al agente ─────────────────────────────────────────────────────

test('el feedback lista lo que fallo y lo que paso, con el numero de PR', () => {
  const feedback = formatGateFeedback(42, [
    check('test', 'failure', '2 tests fallando en src/auth/login.test.ts'),
    check('build', 'success'),
  ]);

  assert.match(feedback, /Intento anterior \(PR #42\) falló:/);
  assert.match(feedback, /✗ test — 2 tests fallando en src\/auth\/login\.test\.ts/);
  assert.match(feedback, /✓ build/);
});

test('el feedback termina prohibiendo tocar los tests', () => {
  // Sin esta linea, un agente presionado por un gate tiende a "arreglar" el
  // test en vez del codigo (spec 004).
  const feedback = formatGateFeedback(1, [check('test', 'failure')]);
  assert.match(feedback.trim().split('\n').at(-1)!, /No modifiques los tests/);
});

test('el feedback de un timeout dice que no hubo respuesta de CI', () => {
  const feedback = formatGateFeedback(7, [running('test')], 'checks_timeout');
  assert.match(feedback, /checks_timeout/);
  assert.match(feedback, /… test/);
});

test('un resumen largo se recorta: el feedback va al prompt, no es un log', () => {
  const feedback = formatGateFeedback(1, [check('test', 'failure', 'x'.repeat(5_000))]);
  assert.ok(feedback.length < 1_500, `largo ${feedback.length}`);
});
