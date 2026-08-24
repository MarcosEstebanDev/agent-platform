import test from 'node:test';
import assert from 'node:assert/strict';
import { EnqueueTicketUseCase } from './enqueue-ticket.use-case.js';
import { FakeQueue, FakeTicketRepository } from './fakes.js';

function build() {
  const tickets = new FakeTicketRepository();
  const queue = new FakeQueue();
  return { tickets, queue, useCase: new EnqueueTicketUseCase(tickets, queue) };
}

test('encolar reserva el ticket: BACKLOG queda en ASSIGNED', async () => {
  const { tickets, queue, useCase } = build();
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  assert.deepEqual(queue.enqueued, ['T-1']);
  assert.equal((await tickets.findById('T-1'))!.status, 'ASSIGNED');
});

test('NO deja el ticket en IN_PROGRESS: eso lo hace el worker al tomarlo', async () => {
  const { tickets, useCase } = build();
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  assert.notEqual(
    (await tickets.findById('T-1'))!.status,
    'IN_PROGRESS',
    'un ticket encolado y nunca procesado quedaria colgado para siempre',
  );
});

test('encolar dos veces produce un solo job', async () => {
  const { tickets, queue, useCase } = build();
  tickets.seed('BACKLOG');

  const primero = await useCase.execute('T-1');
  const segundo = await useCase.execute('T-1');

  assert.equal(primero.ok, true);
  assert.equal(segundo.ok, true);
  assert.equal(queue.enqueued.length, 1);
  if (!primero.ok || !segundo.ok) return;
  assert.equal(primero.jobId, segundo.jobId);
});

test('un ticket ya en DONE no se encola', async () => {
  const { tickets, queue, useCase } = build();
  tickets.seed('DONE');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid_status');
  assert.equal(queue.enqueued.length, 0);
});

test('un ticket FAILED se puede reintentar: vuelve a ASSIGNED y se encola', async () => {
  const { tickets, queue, useCase } = build();
  tickets.seed('FAILED');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  assert.deepEqual(queue.enqueued, ['T-1']);
  assert.equal(
    (await tickets.findById('T-1'))!.status,
    'ASSIGNED',
    'sin esto, el FAILED que escribe el reaper seria un callejon sin salida',
  );
});

test('ticket inexistente: not_found', async () => {
  const { useCase } = build();

  const result = await useCase.execute('NO-EXISTE');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_found');
});

test('con la cola caida el ticket NO se pierde: queda en ASSIGNED', async () => {
  const { tickets, queue, useCase } = build();
  tickets.seed('BACKLOG');
  queue.available = false;

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'queue_unavailable');
  assert.equal(
    (await tickets.findById('T-1'))!.status,
    'ASSIGNED',
    'ASSIGNED es reintentable; perder el ticket porque Redis parpadeo no lo es',
  );
});

test('reintentar despues de que la cola vuelve funciona sin tocar el ticket', async () => {
  const { tickets, queue, useCase } = build();
  tickets.seed('BACKLOG');
  queue.available = false;
  await useCase.execute('T-1');

  queue.available = true;
  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  assert.deepEqual(queue.enqueued, ['T-1']);
});
