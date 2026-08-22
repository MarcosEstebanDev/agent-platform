/**
 * Composition root. Es lo único que conoce a los adapters concretos.
 *
 * En la fase 1 esto se convierte en un módulo de NestJS: el wiring cambia,
 * el dominio no.
 */
import { AgentRunner, type AgentEvent } from './domain/agent-runner.js';
import { OpenAiCompatibleAdapter } from './infrastructure/llm/openai-compatible.adapter.js';
import { DockerSandbox } from './infrastructure/sandbox/docker.sandbox.js';

// Tarea por defecto del MVP-0. Usa el test runner nativo de Node, así el loop
// cierra sin npm install y el container puede correr sin red.
const DEFAULT_TASK = `Creá en /workspace dos archivos:

1. calculator.mjs — exporta una función divide(a, b) que devuelva a/b,
   y que lance un Error con mensaje "division by zero" si b es 0.
2. calculator.test.mjs — tests con los módulos nativos node:test y node:assert.
   Cubrí el caso normal y el de división por cero.

Después ejecutá "node --test" en /workspace y reportá la salida real.`;

function render(event: AgentEvent): void {
  switch (event.type) {
    case 'text':
      console.log(`\n${event.text}`);
      break;
    case 'tool_call': {
      const detail =
        typeof event.args.command === 'string'
          ? event.args.command
          : typeof event.args.path === 'string'
            ? event.args.path
            : '';
      console.log(`  ▸ ${event.name}  ${detail}`);
      break;
    }
    case 'tool_result':
      console.log(`  ${event.ok ? '✓' : '✗'} ${event.preview.replace(/\n/g, ' ⏎ ')}`);
      break;
    case 'done':
      console.log(
        `\n${event.reason === 'completed' ? '✓ Terminado' : '⚠ Cortado por max_iterations'}`,
      );
      break;
  }
}

async function main(): Promise<void> {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
  if (!LLM_BASE_URL || !LLM_API_KEY || LLM_API_KEY === 'PEGA_TU_API_KEY_ACA') {
    console.error(
      '✗ Faltan LLM_BASE_URL / LLM_API_KEY en .env\n' +
        '  Groq (free tier, sin tarjeta): console.groq.com/keys',
    );
    process.exit(1);
  }

  const task = process.argv.slice(2).join(' ') || DEFAULT_TASK;

  const llm = new OpenAiCompatibleAdapter({
    baseUrl: LLM_BASE_URL,
    apiKey: LLM_API_KEY,
    model: LLM_MODEL ?? 'llama-3.3-70b-versatile',
  });
  const sandbox = new DockerSandbox({
    image: process.env.SANDBOX_IMAGE,
    network: process.env.SANDBOX_NETWORK === 'bridge' ? 'bridge' : 'none',
  });

  console.log(`Modelo:  ${llm.modelName}`);
  console.log('Sandbox: levantando container...');

  await sandbox.start();

  // Si el proceso muere de golpe, el container queda huérfano comiendo RAM.
  const cleanup = () => void sandbox.stop().then(() => process.exit(130));
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  try {
    console.log('Sandbox: listo\n─────────────────────────────────────────');
    const result = await new AgentRunner(llm, sandbox).run(task, render);

    console.log('─────────────────────────────────────────');
    console.log(
      `Iteraciones: ${result.iterations}   ` +
        `Tokens in:${result.usage.input} out:${result.usage.output}`,
    );
    console.log('Costo: US$0.00 (free tier)');
  } finally {
    await sandbox.stop();
  }
}

main().catch((err) => {
  console.error('\n✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
