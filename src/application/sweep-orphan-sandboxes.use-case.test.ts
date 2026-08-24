import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSandboxJanitor, FakeTicketRepository } from './fakes.js';
import { SweepOrphanSandboxesUseCase } from './sweep-orphan-sandboxes.use-case.js';

/**
 * El reaper cierra la corrida en la base; este barrido libera la memoria de
 * la maquina. La pregunta "¿este container es basura?" NO se le hace a Docker
 * -- `sleep infinity` vive para siempre aunque no haya nadie usandolo -- sino
 * a la base, que es la unica que sabe si alguien sigue latiendo.
 */

const VIEJO = 5 * 60_000;

/** Un container gestionado por la plataforma, con su corrida y su edad. */
function container(runId: string, ageMs = VIEJO) {
  return { containerId: `c-${runId}`, runId, ageMs };
}

test('destruye el container de una corrida que ya cerro', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const run = await tickets.startRun({ ticketId: 'T-1', model: 'm' });
  await tickets.finishRun(run.id, {
    outcome: 'abandoned',
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
  });

  const janitor = new FakeSandboxJanitor([container(run.id)]);
  const result = await new SweepOrphanSandboxesUseCase(tickets, janitor).execute();

  assert.equal(result.destroyed, 1);
  assert.deepEqual(janitor.destroyed, [`c-${run.id}`]);
});

test('NO toca el container de una corrida abierta', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const run = await tickets.startRun({ ticketId: 'T-1', model: 'm' });

  const janitor = new FakeSandboxJanitor([container(run.id)]);
  const result = await new SweepOrphanSandboxesUseCase(tickets, janitor).execute();

  // Una corrida legitima puede durar mucho sin producir nada visible.
  // Matar su container por "viejo" seria destruir trabajo bueno.
  assert.equal(result.destroyed, 0);
  assert.deepEqual(janitor.destroyed, []);
});

test('un container recien creado nunca es candidato', async () => {
  const tickets = new FakeTicketRepository();
  const janitor = new FakeSandboxJanitor([container('run-fantasma', 1_000)]);

  const result = await new SweepOrphanSandboxesUseCase(tickets, janitor, 60_000).execute();

  // La gracia cubre una carrera concreta: la corrida se marca terminada ANTES
  // de que stop() alcance a destruir el container. Sin ella, un barrido en esa
  // ventana destruiria un sandbox del que su dueño se esta despidiendo.
  assert.equal(result.destroyed, 0);
});

test('un container cuya corrida no existe en la base tambien es huerfano', async () => {
  const tickets = new FakeTicketRepository();
  const janitor = new FakeSandboxJanitor([container('run-borrada')]);

  const result = await new SweepOrphanSandboxesUseCase(tickets, janitor).execute();

  // La fila pudo irse con su ticket (onDelete: Cascade) y el container quedar.
  assert.equal(result.destroyed, 1);
  assert.deepEqual(result.runIds, ['run-borrada']);
});

test('separa huerfanos de vivos en el mismo barrido', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const vivo = await tickets.startRun({ ticketId: 'T-1', model: 'm' });
  const muerto = await tickets.startRun({ ticketId: 'T-1', model: 'm' });
  await tickets.finishRun(muerto.id, {
    outcome: 'abandoned',
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
  });

  const janitor = new FakeSandboxJanitor([container(vivo.id), container(muerto.id)]);
  const result = await new SweepOrphanSandboxesUseCase(tickets, janitor).execute();

  assert.equal(result.destroyed, 1);
  assert.deepEqual(janitor.destroyed, [`c-${muerto.id}`]);
});

test('sin containers gestionados no consulta la base', async () => {
  const tickets = new FakeTicketRepository();
  let consultas = 0;
  tickets.findOpenRunIds = async () => {
    consultas++;
    return [];
  };

  const result = await new SweepOrphanSandboxesUseCase(
    tickets,
    new FakeSandboxJanitor([]),
  ).execute();

  // El caso normal es "no hay nada que limpiar", y corre cada 30 segundos:
  // no tiene que costar una consulta.
  assert.equal(result.destroyed, 0);
  assert.equal(consultas, 0);
});

test('una edad ilegible no protege al container: lo juzga la base', async () => {
  const tickets = new FakeTicketRepository();
  const janitor = new FakeSandboxJanitor([
    { containerId: 'c-raro', runId: 'run-x', ageMs: Number.POSITIVE_INFINITY },
  ]);

  const result = await new SweepOrphanSandboxesUseCase(tickets, janitor).execute();

  // El adapter usa Infinity cuando no puede parsear la fecha de creacion.
  // Que un dato ilegible dejara al container joven para siempre lo volveria
  // inmortal, que es exactamente el bug que este barrido viene a arreglar.
  assert.equal(result.destroyed, 1);
});
