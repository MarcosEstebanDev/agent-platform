import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmPort, LlmResponse } from '../domain/ports/llm.port.js';
import {
  FakeLlm,
  FakeSandbox,
  FakeSandboxFactory,
  FakeTicketRepository,
  textResponse,
  toolResponse,
} from './fakes.js';
import { RunTicketUseCase } from './run-ticket.use-case.js';

/**
 * Estos tests corren sin base de datos, sin Docker y sin LLM.
 *
 * Ese es el retorno concreto de la arquitectura hexagonal: la logica de
 * orquestacion -la parte que puede corromper estado- se verifica en
 * milisegundos, contra dobles de prueba.
 */

function build(scripted: Array<LlmResponse | Error>) {
  const tickets = new FakeTicketRepository();
  const llm = new FakeLlm(scripted);
  const sandboxes = new FakeSandboxFactory();
  return {
    tickets,
    llm,
    sandboxes,
    useCase: new RunTicketUseCase(tickets, llm, sandboxes),
  };
}

// ─── Ciclo de vida ──────────────────────────────────────────────────────────

test('camino feliz: BACKLOG termina en DONE pasando por ASSIGNED', async () => {
  const { tickets, useCase } = build([toolResponse('echo hola'), textResponse('listo')]);
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'DONE');
  assert.equal(result.summary.outcome, 'completed');
});

test('persiste la traza completa, en orden y sin huecos', async () => {
  const { tickets, useCase } = build([toolResponse('echo hola'), textResponse('listo')]);
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  const seqs = tickets.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs.keys()], 'los seq deben ser 0,1,2,... sin saltos');

  const tipos = tickets.events.map((e) => e.event.type);
  assert.ok(tipos.includes('tool_call'));
  assert.ok(tipos.includes('tool_result'));
  assert.equal(tipos.at(-1), 'done');
});

test('cierra la corrida con el resumen', async () => {
  const { tickets, useCase } = build([textResponse('listo')]);
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  assert.equal(tickets.finished.length, 1);
  assert.equal(tickets.finished[0]!.summary.outcome, 'completed');
});

test('ticket inexistente devuelve not_found sin tocar el sandbox', async () => {
  const { sandboxes, useCase } = build([]);

  const result = await useCase.execute('NO-EXISTE');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_found');
  assert.equal(sandboxes.created.length, 0, 'no deberia levantar un container');
});

test('un ticket en DONE no se puede reejecutar', async () => {
  const { tickets, sandboxes, useCase } = build([]);
  tickets.seed('DONE');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid_status');
  assert.equal(sandboxes.created.length, 0);
});

// ─── Fallas ─────────────────────────────────────────────────────────────────

test('si el LLM explota, el ticket termina en FAILED y no colgado', async () => {
  const { tickets, useCase } = build([new Error('502 del proveedor')]);
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'FAILED');
  assert.equal(result.summary.outcome, 'error');
  assert.match(result.summary.error ?? '', /502/);
});

test('el sandbox se destruye SIEMPRE, tambien cuando la corrida falla', async () => {
  const { tickets, sandboxes, useCase } = build([new Error('boom')]);
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  assert.equal(sandboxes.created.length, 1);
  assert.equal(sandboxes.created[0]!.stopped, 1, 'container huerfano = RAM perdida');
});

test('cada corrida usa un sandbox nuevo: un ticket no ve los archivos de otro', async () => {
  const { tickets, sandboxes, useCase } = build([textResponse('a'), textResponse('b')]);
  tickets.seed('BACKLOG', 'T-1');
  tickets.seed('BACKLOG', 'T-2');

  await useCase.execute('T-1');
  await useCase.execute('T-2');

  assert.equal(sandboxes.created.length, 2);
  assert.notEqual(sandboxes.created[0], sandboxes.created[1]);
});

test('si otro worker se adelanta, devuelve already_taken sin ejecutar nada', async () => {
  const { tickets, sandboxes, useCase } = build([]);
  tickets.seed('ASSIGNED');

  // Simula la carrera: el compare-and-set del claim no encuentra el estado esperado.
  const original = tickets.transition.bind(tickets);
  tickets.transition = async (id, from, to) =>
    from === 'ASSIGNED' && to === 'IN_PROGRESS' ? null : original(id, from, to);

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'already_taken');
  assert.equal(sandboxes.created.length, 0);
});

test('un fallo al persistir un evento no mata la corrida', async () => {
  const { tickets, useCase } = build([textResponse('listo')]);
  tickets.seed('BACKLOG');
  tickets.appendEvent = async () => {
    throw new Error('base caida');
  };

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'DONE', 'el log es best-effort, no bloqueante');
});

// ─── Fase 1b: latido y presupuestos ─────────────────────────────────────────

/** LLM que tarda, para que el intervalo de latido tenga tiempo de disparar. */
class SlowLlm implements LlmPort {
  readonly modelName = 'slow-model';
  constructor(private readonly delayMs: number) {}
  async complete(): Promise<LlmResponse> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return textResponse('listo');
  }
}

test('reporta latido mientras la corrida esta en curso', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const useCase = new RunTicketUseCase(
    tickets,
    new SlowLlm(60),
    new FakeSandboxFactory(),
    {},
    5, // heartbeat cada 5 ms
  );

  await useCase.execute('T-1');

  assert.ok(
    tickets.heartbeats.length >= 1,
    'sin latido el reaper mataria una corrida viva',
  );
});

test('el latido se corta al terminar: no sigue latiendo una corrida cerrada', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const useCase = new RunTicketUseCase(
    tickets,
    new FakeLlm([textResponse('listo')]),
    new FakeSandboxFactory(),
    {},
    5,
  );

  await useCase.execute('T-1');
  const alTerminar = tickets.heartbeats.length;
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(tickets.heartbeats.length, alTerminar, 'el intervalo quedo vivo');
});

test('agotar el presupuesto de tokens deja el ticket en FAILED con el motivo', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const useCase = new RunTicketUseCase(
    tickets,
    // Una sola iteracion que consume mas que todo el presupuesto.
    new FakeLlm([toolResponse('echo', { input: 60_000, output: 60_000 })]),
    new FakeSandboxFactory(),
    { maxTokens: 100_000 },
  );

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'FAILED');
  assert.equal(result.summary.outcome, 'budget_exceeded');
  assert.match(result.summary.error ?? '', /tokens/);
});

test('el arranque del sandbox descuenta del presupuesto de tiempo', async () => {
  // Sandbox que tarda en levantar mas que todo el presupuesto. Si el reloj
  // arrancara dentro del loop, esta corrida terminaria bien y el techo de
  // tiempo seria una promesa vacia.
  class SandboxLento extends FakeSandbox {
    override async start(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  const lentos = new FakeSandboxFactory();
  lentos.create = () => {
    const s = new SandboxLento();
    lentos.created.push(s);
    return s;
  };

  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const useCase = new RunTicketUseCase(
    tickets,
    new FakeLlm([textResponse('listo')]),
    lentos,
    { maxWallClockMs: 50 },
  );

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.summary.outcome, 'budget_exceeded');
  assert.match(result.summary.error ?? '', /wall_clock/);
});

test('el ultimo evento persistido dice por que se corto', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const useCase = new RunTicketUseCase(
    tickets,
    new FakeLlm([toolResponse('echo', { input: 60_000, output: 60_000 })]),
    new FakeSandboxFactory(),
    { maxTokens: 100_000 },
  );

  await useCase.execute('T-1');

  const ultimo = tickets.events.at(-1)!.event;
  assert.equal(ultimo.type, 'done');
  if (ultimo.type !== 'done') return;
  assert.equal(ultimo.reason, 'budget_exceeded');
  assert.equal(ultimo.budget, 'tokens');
});
