import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmPort, LlmResponse } from '../domain/ports/llm.port.js';
import { VcsError } from '../domain/ports/vcs.port.js';
import {
  deliveryFor,
  FakeLlm,
  FakeSandbox,
  FakeSandboxFactory,
  FakeTicketRepository,
  FakeVcs,
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

function build(
  scripted: Array<LlmResponse | Error>,
  prepare?: (sandbox: FakeSandbox) => void,
) {
  const tickets = new FakeTicketRepository();
  const llm = new FakeLlm(scripted);
  const sandboxes = new FakeSandboxFactory(prepare);
  const vcs = new FakeVcs();
  return {
    tickets,
    llm,
    sandboxes,
    vcs,
    useCase: new RunTicketUseCase(tickets, llm, sandboxes, deliveryFor(tickets, vcs)),
  };
}

// ─── Ciclo de vida ──────────────────────────────────────────────────────────

test('camino feliz: BACKLOG termina en PR_OPEN pasando por ASSIGNED', async () => {
  const { tickets, useCase } = build([toolResponse('echo hola'), textResponse('listo')]);
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'PR_OPEN');
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

  // La traza mezcla dos emisores: el agente termina con 'done', y despues el
  // orquestador anota que rescato del sandbox. Por eso 'done' es el ultimo
  // evento DEL AGENTE, no el ultimo de la traza.
  assert.equal(tipos.at(-1), 'artifact', 'el rescate se anota despues del done');
  assert.equal(tipos.at(-2), 'done');
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
  assert.equal(result.ticket.status, 'PR_OPEN', 'el log es best-effort, no bloqueante');
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
    deliveryFor(tickets),
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
    deliveryFor(tickets),
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
    deliveryFor(tickets),
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
    deliveryFor(tickets),
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
    deliveryFor(tickets),
    { maxTokens: 100_000 },
  );

  await useCase.execute('T-1');

  const done = tickets.events.map((e) => e.event).findLast((e) => e.type === 'done');
  assert.ok(done, 'la traza tiene que decir por que se corto');
  if (done.type !== 'done') return;
  assert.equal(done.reason, 'budget_exceeded');
  assert.equal(done.budget, 'tokens');
});

// ─── Rescate del trabajo ────────────────────────────────────────────────────
//
// `stop()` es irreversible: lo que el agente escribio solo existe dentro del
// container. Si no se saca antes de apagarlo, no hay nada que poner en un PR.

test('extrae el trabajo ANTES de destruir el sandbox', async () => {
  const { tickets, sandboxes, useCase } = build(
    [textResponse('listo')],
    (sandbox) => {
      sandbox.files = [{ path: 'sum.mjs', content: 'export const sum = 1;', bytes: 21 }];
    },
  );
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  const sandbox = sandboxes.created[0]!;
  assert.equal(sandbox.stopped, 1, 'el sandbox igual se destruye');
  // Lo que se verifica no es que ambos hayan pasado, sino el ORDEN: si el
  // rescate ocurriera despues del stop(), el workspace ya no existiria.
  assert.equal(sandbox.stoppedAtExport, 0, 'se exporto con el sandbox todavia vivo');
});

test('persiste lo que el agente dejo en el workspace', async () => {
  const { tickets, useCase } = build([textResponse('listo')], (sandbox) => {
    sandbox.files = [
      { path: 'sum.mjs', content: 'export const sum = (a, b) => a + b;', bytes: 34 },
      { path: 'sum.test.mjs', content: 'import { sum }', bytes: 14 },
    ];
  });
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.artifact.files, 2);
  assert.equal(result.artifact.bytes, 48);

  const guardado = await tickets.getRunArtifact(result.runId);
  assert.ok(guardado, 'el artefacto tiene que sobrevivir a la corrida');
  assert.deepEqual(
    guardado.files.map((f) => f.path),
    ['sum.mjs', 'sum.test.mjs'],
  );
});

test('el rescate queda en la traza, para explicar un PR vacio', async () => {
  const { tickets, useCase } = build([textResponse('listo')], (sandbox) => {
    sandbox.files = [{ path: 'a.txt', content: 'hola', bytes: 4 }];
  });
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  const evento = tickets.events.map((e) => e.event).findLast((e) => e.type === 'artifact');
  assert.ok(evento);
  if (evento.type !== 'artifact') return;
  assert.equal(evento.files, 1);
  assert.equal(evento.bytes, 4);
});

test('un rescate fallido NO convierte una corrida exitosa en falla', async () => {
  const { tickets, useCase } = build([textResponse('listo')], (sandbox) => {
    sandbox.exportFails = new Error('docker exec murio');
  });
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // El agente resolvio la tarea: que falle sacar los archivos no invalida
  // lo que hizo, y la corrida cierra como completada.
  assert.equal(result.summary.outcome, 'completed');
  // Pero sin artefacto no hay PR posible, y eso lo decide el flujo del PR,
  // no el rescate (ADR 0010): el ticket termina en FAILED con el motivo.
  assert.equal(result.ticket.status, 'FAILED');
  assert.match(result.ticket.statusReason ?? '', /artefacto/i);
  // Pero tampoco se calla: un PR vacio sin explicacion es peor que uno que
  // dice por que esta vacio.
  assert.match(result.artifact.error ?? '', /docker exec murio/);
});

test('un rescate fallido queda registrado en la traza', async () => {
  const { tickets, useCase } = build([textResponse('listo')], (sandbox) => {
    sandbox.exportFails = new Error('sin espacio');
  });
  tickets.seed('BACKLOG');

  await useCase.execute('T-1');

  const evento = tickets.events.map((e) => e.event).findLast((e) => e.type === 'artifact');
  assert.ok(evento);
  if (evento.type !== 'artifact') return;
  assert.match(evento.error ?? '', /sin espacio/);
});

test('si el sandbox nunca arranco, no se intenta rescatar nada', async () => {
  const tickets = new FakeTicketRepository();
  tickets.seed('BACKLOG');
  const sandboxes = new FakeSandboxFactory();
  // Un sandbox que no levanta: el error real es ese, y no debe quedar tapado
  // por un "el sandbox no esta iniciado" que vendria del rescate.
  sandboxes.create = () => {
    const sandbox = new FakeSandbox();
    sandbox.start = () => Promise.reject(new Error('Docker no responde'));
    sandboxes.created.push(sandbox);
    return sandbox;
  };

  const result = await new RunTicketUseCase(
    tickets,
    new FakeLlm([textResponse('listo')]),
    sandboxes,
    deliveryFor(tickets),
  ).execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.summary.outcome, 'error');
  assert.match(result.summary.error ?? '', /Docker no responde/);
  assert.equal(sandboxes.created[0]!.filesAtExport, null, 'no se intento exportar');
});

test('el sandbox se crea con el id de la corrida', async () => {
  const { tickets, sandboxes, useCase } = build([textResponse('listo')]);
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Sin esta identidad, un container que sobrevive a su worker es
  // indistinguible de uno que esta trabajando.
  assert.equal(sandboxes.contexts[0]!.runId, result.runId);
});

// ─── Entrega: del agente al PR (fases 2 y 3) ────────────────────────────────

test('una corrida completada termina en PR_OPEN, nunca en DONE', async () => {
  // ADR 0007: el agente no da el veredicto. DONE lo deciden los checks.
  const { tickets, vcs, useCase } = build([textResponse('listo')]);
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'PR_OPEN');
  assert.equal(vcs.pullRequests.length, 1);
  assert.ok(vcs.branches.has('feature/TICKET-T-1'));
});

test('una corrida que no termina no abre PR', async () => {
  const { tickets, vcs, useCase } = build([new Error('LLM caido')]);
  tickets.seed('BACKLOG');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'FAILED');
  assert.equal(vcs.branches.size, 0);
});

test('repo inaccesible: FAILED antes de gastar tokens', async () => {
  const { tickets, llm, sandboxes, vcs, useCase } = build([textResponse('listo')]);
  tickets.seed('BACKLOG');
  vcs.failAccess = new VcsError('not_found', 'No existe marcos/sandbox o el token no lo ve');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'delivery_unavailable');
  assert.equal(llm.calls, 0, 'ni un token');
  assert.equal(sandboxes.created.length, 0, 'ni un container');
  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'FAILED');
  assert.match(ticket?.statusReason ?? '', /No existe marcos\/sandbox/);
});

test('el feedback de los checks fallidos llega al task del reintento', async () => {
  const seen: string[] = [];
  const tickets = new FakeTicketRepository();
  const llm: LlmPort = {
    modelName: 'spy',
    async complete(messages) {
      seen.push(JSON.stringify(messages));
      return textResponse('listo');
    },
  };
  tickets.seed('ASSIGNED', 'T-1', {
    gateFeedback: 'Intento anterior (PR #42) falló:\n  ✗ test — Expected 401',
  });

  await new RunTicketUseCase(
    tickets,
    llm,
    new FakeSandboxFactory(),
    deliveryFor(tickets),
  ).execute('T-1');

  assert.match(seen[0] ?? '', /hacer algo/, 'el task original sigue');
  assert.match(seen[0] ?? '', /Intento anterior \(PR #42\)/);
});

test('el ciclo de correccion suma un commit a la misma rama y reusa el PR', async () => {
  const { tickets, vcs, useCase } = build([textResponse('listo'), textResponse('listo')]);
  tickets.seed('BACKLOG');
  await useCase.execute('T-1');

  // Lo que hace EvaluateGatesUseCase cuando CI da rojo.
  await tickets.transition('T-1', 'PR_OPEN', 'CHECKS_RUNNING');
  await tickets.transition('T-1', 'CHECKS_RUNNING', 'CHANGES_REQUESTED');
  await tickets.transition('T-1', 'CHANGES_REQUESTED', 'ASSIGNED');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticket.status, 'PR_OPEN');
  assert.equal(vcs.branches.get('feature/TICKET-T-1')!.length, 2, 'dos commits, una rama');
  assert.equal(vcs.pullRequests.length, 1, 'el mismo PR');
});
