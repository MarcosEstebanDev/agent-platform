import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeTicketRepository } from './fakes.js';
import { ReapStaleRunsUseCase } from './reap-stale-runs.use-case.js';

const DOS_MINUTOS = 2 * 60_000;

test('cierra la corrida sin latido y saca al ticket de IN_PROGRESS', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('IN_PROGRESS');
  tickets.seedRun('T-1', 5 * 60_000); // ultimo latido hace 5 minutos

  const result = await new ReapStaleRunsUseCase(tickets, DOS_MINUTOS).execute();

  assert.equal(result.reaped, 1);
  assert.deepEqual(result.ticketIds, ['T-1']);
  assert.equal(tickets.finished[0]!.summary.outcome, 'abandoned');
  assert.equal((await tickets.findById('T-1'))!.status, 'FAILED');
});

test('no toca una corrida que sigue latiendo', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('IN_PROGRESS');
  tickets.seedRun('T-1', 30_000); // latio hace 30 s: esta viva

  const result = await new ReapStaleRunsUseCase(tickets, DOS_MINUTOS).execute();

  assert.equal(result.reaped, 0);
  assert.equal((await tickets.findById('T-1'))!.status, 'IN_PROGRESS');
});

test('deja el ticket en FAILED y no en ASSIGNED: no se reencola solo', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('IN_PROGRESS');
  tickets.seedRun('T-1', 5 * 60_000);

  await new ReapStaleRunsUseCase(tickets, DOS_MINUTOS).execute();

  assert.equal(
    (await tickets.findById('T-1'))!.status,
    'FAILED',
    'reencolar solo un ticket que quizas es toxico es como se hace un loop caro',
  );
});

test('el barrido es idempotente: correrlo dos veces no cierra dos veces', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('IN_PROGRESS');
  tickets.seedRun('T-1', 5 * 60_000);
  const reaper = new ReapStaleRunsUseCase(tickets, DOS_MINUTOS);

  await reaper.execute();
  const segundo = await reaper.execute();

  assert.equal(segundo.reaped, 0, 'la corrida ya cerrada no vuelve a aparecer');
  assert.equal(tickets.finished.length, 1);
});

test('varias corridas colgadas se cierran todas en un barrido', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('IN_PROGRESS', 'T-1');
  tickets.seed('IN_PROGRESS', 'T-2');
  tickets.seedRun('T-1', 10 * 60_000);
  tickets.seedRun('T-2', 10 * 60_000);

  const result = await new ReapStaleRunsUseCase(tickets, DOS_MINUTOS).execute();

  assert.equal(result.reaped, 2);
  assert.deepEqual(result.ticketIds.sort(), ['T-1', 'T-2']);
});

test('si el ticket ya no esta en IN_PROGRESS, cierra la corrida pero no lo pisa', async () => {
  const tickets = new FakeTicketRepository();
  // El worker alcanzo a cerrar el ticket pero murio antes de cerrar la corrida.
  tickets.seed('DONE');
  tickets.seedRun('T-1', 5 * 60_000);

  const result = await new ReapStaleRunsUseCase(tickets, DOS_MINUTOS).execute();

  assert.equal(tickets.finished.length, 1, 'la corrida huerfana igual se cierra');
  assert.deepEqual(result.ticketIds, [], 'pero el DONE no se degrada a FAILED');
  assert.equal((await tickets.findById('T-1'))!.status, 'DONE');
});
