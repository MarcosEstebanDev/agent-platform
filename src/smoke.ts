/**
 * Smoke test del sandbox. NO usa el LLM, así que corre sin ningún token.
 *
 * Sirve para separar los dos hemisferios del sistema: si esto pasa, cualquier
 * falla posterior está del lado del modelo, no del sandbox.
 */
import { DockerSandbox } from './infrastructure/sandbox/docker.sandbox.js';

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const sandbox = new DockerSandbox({
    image: process.env.SANDBOX_IMAGE,
    network: process.env.SANDBOX_NETWORK === 'bridge' ? 'bridge' : 'none',
  });

  console.log('Levantando container (la primera vez baja la imagen)...\n');
  await sandbox.start();

  try {
    const node = await sandbox.exec('node --version');
    check('node disponible', node.exitCode === 0, node.stdout.trim());

    const bash = await sandbox.exec('echo hola desde el sandbox');
    check('bash ejecuta', bash.stdout.includes('hola desde el sandbox'));

    const fail = await sandbox.exec('exit 42');
    check('propaga exit codes', fail.exitCode === 42, `exit ${fail.exitCode}`);

    const weird = 'línea 1\n"comillas" y $VAR y `backticks`\nlínea 3';
    await sandbox.writeFile('/workspace/sub/dir/test.txt', weird);
    const readBack = await sandbox.readFile('/workspace/sub/dir/test.txt');
    check('write_file / read_file sin corromper contenido', readBack === weird);

    await sandbox.writeFile(
      '/workspace/t.test.mjs',
      "import {test} from 'node:test';import a from 'node:assert';" +
        "test('ok',()=>a.strictEqual(1+1,2));",
    );
    const tests = await sandbox.exec('node --test');
    check('node --test corre', tests.exitCode === 0);

    const net = await sandbox.exec('timeout 5 getent hosts github.com');
    const isolated = net.exitCode !== 0;
    check(
      'red',
      true,
      isolated ? 'aislada (--network none)' : 'con salida a internet',
    );
  } finally {
    await sandbox.stop();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('\n─────────────────────────────────────────');
  if (failed.length === 0) {
    console.log('✓ Sandbox operativo. Falta sólo el token para correr el agente.');
  } else {
    console.log(`✗ ${failed.length} check(s) fallaron: ${failed.map((c) => c.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
