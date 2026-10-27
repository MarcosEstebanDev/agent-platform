import test from 'node:test';
import assert from 'node:assert/strict';
import { VcsError } from '../domain/ports/vcs.port.js';
import { FakeTicketRepository, FakeVcs } from './fakes.js';
import { OpenPullRequestUseCase } from './open-pull-request.use-case.js';

const REPO = 'marcos/sandbox';
const SECRET = 'github_pat_SECRETO_que_no_debe_filtrarse';

/**
 * Un ticket en IN_PROGRESS con una corrida terminada y su trabajo rescatado:
 * el estado exacto en que RunTicketUseCase le pasa la posta a este caso de uso.
 */
async function build(files = [{ path: 'calc.mjs', content: 'export {}', bytes: 9 }]) {
  const tickets = new FakeTicketRepository();
  const vcs = new FakeVcs();
  const useCase = new OpenPullRequestUseCase(tickets, vcs, {
    repo: REPO,
    base: 'main',
    secrets: [SECRET],
  });

  tickets.seed('IN_PROGRESS');
  const run = await tickets.startRun({ ticketId: 'T-1', model: 'fake-model' });
  await tickets.appendEvent(run.id, 0, {
    type: 'tool_call',
    name: 'bash',
    args: { command: 'node --test' },
  });
  await tickets.appendEvent(run.id, 1, {
    type: 'tool_result',
    name: 'bash',
    ok: true,
    preview: 'exit code: 0',
  });
  await tickets.appendEvent(run.id, 2, { type: 'text', text: 'Soy un genio' });
  await tickets.finishRun(run.id, {
    outcome: 'completed',
    iterations: 4,
    inputTokens: 2000,
    outputTokens: 400,
  });
  await tickets.saveRunArtifact(run.id, {
    files,
    skipped: [],
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    truncated: false,
  });

  return { tickets, vcs, useCase, runId: run.id };
}

// ─── Camino feliz ───────────────────────────────────────────────────────────

test('commitea en feature/TICKET-<id> y deja el ticket en PR_OPEN', async () => {
  const { tickets, vcs, useCase, runId } = await build();

  const result = await useCase.execute('T-1', runId);

  assert.equal(result.ok, true);
  const commits = vcs.branches.get('feature/TICKET-T-1');
  assert.ok(commits, 'la rama tiene que existir');
  assert.deepEqual(commits[0]!.files, [{ path: 'calc.mjs', content: 'export {}' }]);

  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'PR_OPEN');
  assert.equal(ticket?.branch, 'feature/TICKET-T-1');
  assert.equal(ticket?.prNumber, vcs.pullRequests[0]!.number);
  assert.equal(ticket?.prUrl, vcs.pullRequests[0]!.url);
});

test('el cuerpo del PR sale de la traza, no del texto del agente', async () => {
  const { vcs, useCase, runId } = await build();

  await useCase.execute('T-1', runId);

  const body = vcs.pullRequests[0]!.body;
  assert.match(body, /`node --test` → exit 0/);
  assert.match(body, /Corrida: RUN-1/);
  assert.doesNotMatch(body, /Soy un genio/);
});

test('sin runId usa la ultima corrida del ticket', async () => {
  const { vcs, useCase } = await build();

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, true);
  assert.equal(vcs.pullRequests.length, 1);
});

// ─── Modos de falla (spec 003) ──────────────────────────────────────────────

test('rama ajena con el mismo nombre: reintenta con sufijo -2', async () => {
  const { tickets, vcs, useCase, runId } = await build();
  vcs.seedBranch('feature/TICKET-T-1');

  await useCase.execute('T-1', runId);

  assert.equal((await tickets.findById('T-1'))?.branch, 'feature/TICKET-T-1-2');
  assert.equal(vcs.branches.get('feature/TICKET-T-1')!.length, 1, 'no se escribio encima');
});

test('si el PR falla pero el push salio: queda IN_PROGRESS con la rama guardada', async () => {
  const { tickets, vcs, useCase, runId } = await build();
  vcs.failOpenPr = new VcsError('unavailable', 'GitHub 502');

  const result = await useCase.execute('T-1', runId);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'pr_failed');
  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'IN_PROGRESS');
  assert.equal(ticket?.branch, 'feature/TICKET-T-1');
  assert.match(ticket?.statusReason ?? '', /GitHub 502/);
});

test('reintentar el PR no vuelve a crear la rama ni duplica el commit', async () => {
  const { tickets, vcs, useCase, runId } = await build();
  vcs.failOpenPr = new VcsError('unavailable', 'GitHub 502');
  await useCase.execute('T-1', runId);

  vcs.failOpenPr = undefined;
  const result = await useCase.execute('T-1', runId);

  assert.equal(result.ok, true);
  assert.equal(vcs.branches.size, 1, 'una sola rama');
  assert.equal(vcs.branches.get('feature/TICKET-T-1')!.length, 1, 'un solo commit');
  assert.equal((await tickets.findById('T-1'))?.status, 'PR_OPEN');
});

test('si el PR ya existe (otro intento lo abrio), se reusa en vez de fallar', async () => {
  const { tickets, vcs, useCase, runId } = await build();
  await vcs.openPullRequest({
    repo: REPO,
    branch: 'feature/TICKET-T-1',
    base: 'main',
    title: 'x',
    body: 'x',
  });
  await tickets.updateDelivery('T-1', { branch: 'feature/TICKET-T-1' });

  const result = await useCase.execute('T-1', runId);

  assert.equal(result.ok, true);
  assert.equal(vcs.pullRequests.length, 1);
});

test('sin permiso de escritura: FAILED con el scope que falta', async () => {
  const { tickets, vcs, useCase, runId } = await build();
  vcs.failCommit = new VcsError('forbidden', 'Al token le falta "Contents: Read and write"');

  const result = await useCase.execute('T-1', runId);

  assert.equal(result.ok, false);
  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'FAILED');
  assert.match(ticket?.statusReason ?? '', /Contents: Read and write/);
});

test('GitHub caido al pushear: IN_PROGRESS reintentable, no FAILED', async () => {
  const { tickets, vcs, useCase, runId } = await build();
  vcs.failCommit = new VcsError('unavailable', 'timeout');

  const result = await useCase.execute('T-1', runId);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'push_failed');
  assert.equal((await tickets.findById('T-1'))?.status, 'IN_PROGRESS');
});

test('sin artefacto no hay PR: FAILED explicando por que', async () => {
  const { tickets, vcs, useCase, runId } = await build([]);

  const result = await useCase.execute('T-1', runId);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_artifact');
  assert.equal(vcs.branches.size, 0);
  const ticket = await tickets.findById('T-1');
  assert.equal(ticket?.status, 'FAILED');
  assert.match(ticket?.statusReason ?? '', /artefacto/i);
});

test('un ticket fuera de IN_PROGRESS no abre PR', async () => {
  const { tickets, vcs, useCase } = await build();
  await tickets.transition('T-1', 'IN_PROGRESS', 'FAILED');

  const result = await useCase.execute('T-1');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid_status');
  assert.equal(vcs.branches.size, 0);
});

test('el PAT no aparece en ninguna fila de agent_events ni en el ticket', async () => {
  const { tickets, vcs, useCase, runId } = await build();
  // El peor caso: un adapter que se equivoca y mete el token en el mensaje.
  vcs.failOpenPr = new VcsError('unavailable', `fallo con Bearer ${SECRET}`);

  await useCase.execute('T-1', runId);

  const dump = JSON.stringify({ events: tickets.events, ticket: await tickets.findById('T-1') });
  assert.doesNotMatch(dump, new RegExp(SECRET));
});

test('preflight: un repo inaccesible se detecta sin tocar nada mas', async () => {
  const { vcs, useCase } = await build();
  vcs.failAccess = new VcsError('not_found', 'No existe marcos/sandbox o el token no lo ve');

  await assert.rejects(() => useCase.preflight(), /No existe marcos\/sandbox/);
  assert.deepEqual(vcs.accessChecks, [REPO]);
});
