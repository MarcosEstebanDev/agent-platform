import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPullRequestBody, branchFor } from './pull-request-body.js';

const BASE = {
  ticket: { id: 'T-1', title: 'Calculadora', task: 'Crear divide(a, b)' },
  run: { id: 'RUN-1', model: 'fake-model', iterations: 4, inputTokens: 2_000, outputTokens: 400 },
  files: ['calculator.mjs', 'calculator.test.mjs'],
  skipped: [],
};

test('el cuerpo trae titulo, task y el pie con ticket, corrida y modelo', () => {
  const body = buildPullRequestBody({ ...BASE, events: [] });

  assert.match(body, /^## Calculadora/);
  assert.match(body, /Crear divide\(a, b\)/);
  assert.match(body, /Ticket: T-1 · Corrida: RUN-1 · Modelo: fake-model · 4 iteraciones · 2\.4k tokens/);
});

test('lo que hizo el agente sale de la traza, no de su texto', () => {
  const body = buildPullRequestBody({
    ...BASE,
    events: [
      { type: 'tool_call', payload: { name: 'bash', args: { command: 'node --test' } } },
      { type: 'tool_result', payload: { name: 'bash', ok: true, preview: 'exit code: 0\nok 1' } },
      // El agente dice cualquier cosa: no tiene que aparecer en el PR.
      { type: 'text', payload: { text: 'All tests pass successfully, I am great' } },
    ],
  });

  assert.match(body, /2 archivos escritos/);
  assert.match(body, /`node --test` → exit 0/);
  assert.doesNotMatch(body, /I am great/);
});

test('un comando fallido aparece con su exit code real', () => {
  const body = buildPullRequestBody({
    ...BASE,
    events: [
      { type: 'tool_call', payload: { name: 'bash', args: { command: 'npm test' } } },
      { type: 'tool_result', payload: { name: 'bash', ok: false, preview: 'exit code: 1\nnot ok' } },
    ],
  });
  assert.match(body, /`npm test` → exit 1/);
});

test('lo que quedo afuera del rescate se declara en el PR', () => {
  const body = buildPullRequestBody({
    ...BASE,
    events: [],
    skipped: [{ path: 'big.bin', bytes: 10, reason: 'binary' }],
  });
  assert.match(body, /big\.bin \(binary\)/);
});

test('la rama sale del id del ticket', () => {
  assert.equal(branchFor('abc-123'), 'feature/TICKET-abc-123');
  assert.equal(branchFor('abc-123', 2), 'feature/TICKET-abc-123-2');
});
