/**
 * RUN — se corre en cada tarea.
 *
 * Crea una sesión que referencia el agent+environment ya existentes,
 * le manda una tarea y consume el event stream hasta que termina.
 *
 * Esta es la semilla del orquestador: hoy imprime eventos por consola,
 * mañana esos mismos eventos alimentan la máquina de estados del ticket.
 */
import Anthropic from '@anthropic-ai/sdk';

// Tarea por defecto del MVP-0: no monta repo, no instala nada.
// Usa el test runner nativo de Node, así el loop cierra sin depender
// de npm install ni de red. Si esto anda, el runtime funciona.
const DEFAULT_TASK = `Creá en /workspace dos archivos:

1. calculator.mjs — exporta una función divide(a, b) que devuelva a/b,
   y que lance un Error con mensaje "division by zero" si b es 0.
2. calculator.test.mjs — tests usando los módulos nativos node:test y
   node:assert. Cubrí el caso normal y el caso de división por cero.

Después ejecutá "node --test" en /workspace y reportá la salida real.`;

// Precios de claude-opus-5 por millón de tokens.
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

async function main() {
  const { ANTHROPIC_API_KEY, AGENT_ID, ENVIRONMENT_ID } = process.env;

  if (!ANTHROPIC_API_KEY) {
    console.error('✗ Falta ANTHROPIC_API_KEY en .env');
    process.exit(1);
  }
  if (!AGENT_ID || !ENVIRONMENT_ID) {
    console.error('✗ Faltan AGENT_ID / ENVIRONMENT_ID. Corré primero: npm run setup');
    process.exit(1);
  }

  const task = process.argv.slice(2).join(' ') || DEFAULT_TASK;
  const client = new Anthropic();

  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
    title: 'MVP-0',
  });

  console.log(`Sesión: ${session.id}`);
  console.log(`Traza:  https://platform.claude.com/workspaces/default/sessions/${session.id}\n`);

  // ORDEN CRÍTICO: el stream sólo entrega eventos posteriores a su apertura.
  // Si mandás el mensaje primero, perdés los primeros eventos.
  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: task }] }],
  });

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for await (const event of stream) {
    switch (event.type) {
      case 'agent.message':
        for (const block of event.content) {
          if (block.type === 'text') process.stdout.write(block.text);
        }
        break;

      case 'agent.tool_use':
        console.log(`\n  ▸ ${event.name}`);
        break;

      case 'span.model_request_end': {
        const u = event.model_usage;
        if (u) {
          usage.input += u.input_tokens ?? 0;
          usage.output += u.output_tokens ?? 0;
          usage.cacheRead += u.cache_read_input_tokens ?? 0;
          usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
        }
        break;
      }

      case 'session.error':
        console.error(`\n✗ session.error: ${event.error?.message ?? 'desconocido'}`);
        break;
    }

    // Gate de salida. NO alcanza con romper en status_idle: la sesión pasa a
    // idle también cuando espera una acción tuya (confirmar una tool, devolver
    // el resultado de una custom tool). Ahí hay que seguir escuchando.
    if (event.type === 'session.status_terminated') break;
    if (event.type === 'session.status_idle') {
      if (event.stop_reason?.type === 'requires_action') continue;
      break;
    }
  }

  const cost =
    (usage.input * PRICE.input +
      usage.output * PRICE.output +
      usage.cacheRead * PRICE.cacheRead +
      usage.cacheWrite * PRICE.cacheWrite) /
    1_000_000;

  console.log('\n\n─────────────────────────────────────────');
  console.log(
    `Tokens  in:${usage.input}  out:${usage.output}  ` +
      `cache-read:${usage.cacheRead}  cache-write:${usage.cacheWrite}`,
  );
  console.log(`Costo   ~US$${cost.toFixed(4)}`);
  console.log('─────────────────────────────────────────');
}

main().catch((err) => {
  if (err instanceof Anthropic.APIError) {
    console.error(`\n✗ API error ${err.status}: ${err.message}`);
  } else {
    console.error('\n✗', err);
  }
  process.exit(1);
});
