import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { pullRequestsFromCheckSuite, verifySignature } from './webhook.js';

const SECRET = 'secreto-del-webhook';
const body = Buffer.from('{"action":"completed"}');
const sign = (payload: Buffer, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

test('acepta la firma correcta', () => {
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});

test('rechaza una firma hecha con otro secreto', () => {
  assert.equal(verifySignature(body, sign(body, 'otro'), SECRET), false);
});

test('rechaza un cuerpo alterado', () => {
  assert.equal(verifySignature(Buffer.from('{"action":"x"}'), sign(body), SECRET), false);
});

test('rechaza la ausencia de firma y los formatos raros sin explotar', () => {
  for (const header of [undefined, '', 'sha1=abc', 'sha256=', 'sha256=zz']) {
    assert.equal(verifySignature(body, header, SECRET), false, String(header));
  }
});

test('check_suite completado: devuelve los numeros de PR', () => {
  const prs = pullRequestsFromCheckSuite('check_suite', {
    action: 'completed',
    check_suite: { pull_requests: [{ number: 42 }, { number: 43 }] },
  });
  assert.deepEqual(prs, [42, 43]);
});

test('check_run completado tambien cuenta: SonarCloud reporta por ahi', () => {
  const prs = pullRequestsFromCheckSuite('check_run', {
    action: 'completed',
    check_run: { pull_requests: [{ number: 7 }] },
  });
  assert.deepEqual(prs, [7]);
});

test('cualquier otro evento o accion se ignora', () => {
  assert.deepEqual(pullRequestsFromCheckSuite('push', {}), []);
  assert.deepEqual(
    pullRequestsFromCheckSuite('check_suite', {
      action: 'requested',
      check_suite: { pull_requests: [{ number: 1 }] },
    }),
    [],
  );
  assert.deepEqual(pullRequestsFromCheckSuite('check_suite', null), []);
});
