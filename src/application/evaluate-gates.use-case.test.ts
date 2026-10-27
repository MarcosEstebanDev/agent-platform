import test from 'node:test';
import assert from 'node:assert/strict';
import type { TicketDelivery, TicketStatus } from '../domain/ticket.js';
import { EvaluateGatesUseCase } from './evaluate-gates.use-case.js';
import { FakeQualityGate, FakeQueue, FakeTicketRepository, green, red } from './fakes.js';

const MIN = 60_000;

/**
 * Un ticket con su PR abierto, como lo deja OpenPullRequestUseCase. El reloj
 * es manual: el timeout de 30 min se prueba moviendo `clock.now`, no
 * esperando.
 */
function build(status: TicketStatus = 'PR_OPEN', delivery: Partial<TicketDelivery> = {}) {
  const clock = { now: 1_000_000 };
  const tickets = new FakeTicketRepository(() => clock.now);
  const gates = new FakeQualityGate();
  const queue = new FakeQueue();
  const useCase = new EvaluateGatesUseCase(
    tickets,
    gates,
    queue,
    { repo: 'marcos/sandbox', nonBlocking: ['SonarCloud Code Analysis'] },
    () => clock.now,
  );
  tickets.seed(status, 'T-1', {
    branch: 'feature/TICKET-T-1',
    prNumber: 42,
    prUrl: 'https://github.test/pr/42',
    ...delivery,
  });
  return { clock, tickets, gates, queue, useCase };
}

// ─── Veredicto ──────────────────────────────────────────────────────────────

test('PR con checks en verde: DONE sin intervencion', async () => {
  const { tickets, gates, useCase } = build();
  gates.set(42, [green('build'), green('test'), green('lint')]);

  const result = await useCase.execute('T-1');

  assert.equal(result.outcome, 'done');
  assert.equal((await tickets.findById('T-1'))?.status, 'DONE');
});

test('PR con tests en rojo: CHANGES_REQUESTED y vuelve a la cola, no DONE', async () => {
  const { tickets, gates, queue, useCase } = build();
  gates.set(42, [green('build'), red('test', 'Expected 401, received 500')]);

  const result = await useCase.execute('T-1');

  assert.equal(result.outcome, 'requeued');
  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'ASSIGNED');
  assert.equal(ticket?.gateAttempts, 1);
  assert.deepEqual(queue.enqueued, ['T-1'], 'el agente reintenta solo');
});

test('el feedback de los checks fallidos queda listo para el reintento', async () => {
  const { tickets, gates, useCase } = build();
  gates.set(42, [green('build'), red('test', 'Expected 401, received 500')]);

  await useCase.execute('T-1');

  const feedback = (await tickets.findById('T-1'))?.gateFeedback ?? '';
  assert.match(feedback, /Intento anterior \(PR #42\) falló/);
  assert.match(feedback, /✗ test — Expected 401, received 500/);
  assert.match(feedback, /No modifiques los tests/);
});

test('checks corriendo: queda en CHECKS_RUNNING esperando', async () => {
  const { tickets, gates, useCase } = build();
  gates.set(42, [green('build'), { name: 'test', status: 'in_progress', conclusion: null }]);

  const result = await useCase.execute('T-1');

  assert.equal(result.outcome, 'waiting');
  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'CHECKS_RUNNING');
  assert.ok(ticket?.checksStartedAt, 'arranca el reloj del timeout');
});

test('ningun DONE sin al menos un check verde: un PR sin CI espera', async () => {
  const { tickets, gates, useCase } = build();
  gates.set(42, []);

  await useCase.execute('T-1');

  assert.equal((await tickets.findById('T-1'))?.status, 'CHECKS_RUNNING');
});

test('un check no bloqueante en rojo no frena el DONE, pero queda anotado', async () => {
  const { tickets, gates, useCase } = build();
  gates.set(42, [green('test'), red('SonarCloud Code Analysis', 'coverage 41%')]);

  await useCase.execute('T-1');

  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'DONE');
  assert.match(ticket?.statusReason ?? '', /SonarCloud Code Analysis/);
});

// ─── Timeout y tope de reintentos ───────────────────────────────────────────

test('CI colgado 30 min: CHANGES_REQUESTED con checks_timeout', async () => {
  const { clock, tickets, gates, useCase } = build();
  gates.set(42, [{ name: 'test', status: 'queued', conclusion: null }]);
  await useCase.execute('T-1');

  clock.now += 30 * MIN;
  const result = await useCase.execute('T-1');

  assert.equal(result.outcome, 'requeued');
  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'ASSIGNED');
  assert.equal(ticket?.statusReason, 'checks_timeout');
  assert.match(ticket?.gateFeedback ?? '', /checks_timeout/);
});

test('29 minutos no es timeout', async () => {
  const { clock, tickets, gates, useCase } = build();
  gates.set(42, [{ name: 'test', status: 'queued', conclusion: null }]);
  await useCase.execute('T-1');

  clock.now += 29 * MIN;
  await useCase.execute('T-1');

  assert.equal((await tickets.findById('T-1'))?.status, 'CHECKS_RUNNING');
});

test('tres ciclos fallidos terminan en FAILED con gates_exhausted, no en un bucle', async () => {
  const { tickets, gates, queue, useCase } = build('PR_OPEN', { gateAttempts: 2 });
  gates.set(42, [red('test')]);

  const result = await useCase.execute('T-1');

  assert.equal(result.outcome, 'gates_exhausted');
  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'FAILED');
  assert.equal(ticket?.statusReason, 'gates_exhausted');
  assert.equal(ticket?.gateAttempts, 3);
  assert.deepEqual(queue.enqueued, [], 'no se reencola');
});

test('si la cola esta caida el ticket queda ASSIGNED: reintentable, no perdido', async () => {
  const { tickets, gates, queue, useCase } = build();
  gates.set(42, [red('test')]);
  queue.available = false;

  const result = await useCase.execute('T-1');

  assert.equal(result.outcome, 'changes_requested');
  assert.equal((await tickets.findById('T-1'))?.status, 'ASSIGNED');
});

// ─── Webhook + poller ───────────────────────────────────────────────────────

test('evaluar dos veces el mismo PR verde no rompe nada: idempotente', async () => {
  // Webhook y poller pueden llegar a la vez. El segundo encuentra el ticket
  // en DONE y no hace nada.
  const { tickets, gates, useCase } = build();
  gates.set(42, [green('test')]);

  await useCase.execute('T-1');
  const second = await useCase.execute('T-1');

  assert.equal(second.outcome, 'skipped');
  assert.equal((await tickets.findById('T-1'))?.status, 'DONE');
});

test('ignorando el webhook a proposito, el poller cierra el ticket igual', async () => {
  const { tickets, gates, useCase } = build();
  tickets.seed('CHECKS_RUNNING', 'T-2', { prNumber: 43, checksStartedAt: new Date(1_000_000) });
  tickets.seed('BACKLOG', 'T-3');
  gates.set(42, [green('test')]);
  gates.set(43, [green('test')]);

  const results = await useCase.evaluatePending();

  assert.deepEqual(
    results.map((r) => [r.ticketId, r.outcome]).sort(),
    [
      ['T-1', 'done'],
      ['T-2', 'done'],
    ],
  );
  assert.equal((await tickets.findById('T-3'))?.status, 'BACKLOG', 'no toca lo que no espera checks');
});

test('el poller sigue con el resto si un PR falla al consultarse', async () => {
  const { tickets, gates, useCase } = build();
  tickets.seed('PR_OPEN', 'T-2', { prNumber: 43 });
  gates.set(43, [green('test')]);
  const original = gates.fetchChecks.bind(gates);
  gates.fetchChecks = async (repo, pr) => {
    if (pr === 42) throw new Error('GitHub 502');
    return original(repo, pr);
  };

  const results = await useCase.evaluatePending();

  const byId = Object.fromEntries(results.map((r) => [r.ticketId, r]));
  assert.equal(byId['T-1']?.outcome, 'error');
  assert.match(byId['T-1']?.detail ?? '', /GitHub 502/);
  assert.equal(byId['T-2']?.outcome, 'done');
});

test('un ticket que no espera checks no se evalua', async () => {
  const { tickets, gates, useCase } = build('IN_PROGRESS');

  const result = await useCase.execute('T-1');

  assert.equal(result.outcome, 'skipped');
  assert.deepEqual(gates.fetched, []);
  assert.equal((await tickets.findById('T-1'))?.status, 'IN_PROGRESS');
});
