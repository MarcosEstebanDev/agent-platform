/**
 * SETUP — se corre UNA SOLA VEZ.
 *
 * Crea los dos recursos persistentes de la plataforma:
 *   - Environment: la plantilla del container donde se ejecutan las tools.
 *   - Agent:       la config versionada (modelo, system prompt, tools).
 *
 * Anti-patron a evitar: llamar a agents.create() en cada corrida.
 * Eso acumula agentes huerfanos, paga latencia de creacion al pedo y
 * rompe el modelo de versionado. Se crean una vez, se guardan los IDs.
 *
 * Para cambiar el comportamiento del agente NO se crea otro:
 * se usa agents.update(), que genera una version nueva.
 */
import Anthropic from '@anthropic-ai/sdk';

const ENVIRONMENT_NAME = 'agent-platform-dev';
const AGENT_NAME = 'Developer';

const SYSTEM_PROMPT = `Sos un agente de desarrollo trabajando dentro de un container aislado.

Reglas:
- Verificá tu trabajo ejecutando los tests antes de dar una tarea por terminada.
- Reportá el resultado con honestidad: si los tests fallan, decilo y pegá la salida real.
- No agregues features, abstracciones ni refactors más allá de lo que la tarea pide.
- Antes de terminar tu turno, revisá tu último párrafo: si es un plan o una promesa
  de trabajo que todavía no hiciste, hacelo ahora con tool calls.`;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('✗ Falta ANTHROPIC_API_KEY. Copiá .env.example a .env y completala.');
    process.exit(1);
  }

  const client = new Anthropic();

  console.log('Creando environment...');
  const environment = await client.beta.environments.create({
    name: ENVIRONMENT_NAME,
    config: {
      type: 'cloud',
      // Egress abierto: el agente puede instalar paquetes y llegar a internet.
      // En fase 2 esto pasa a 'limited' con allowed_hosts explicitos.
      networking: { type: 'unrestricted' },
    },
  });
  console.log(`  ✓ ${environment.id}`);

  console.log('Creando agent...');
  const agent = await client.beta.agents.create({
    name: AGENT_NAME,
    // 'effort' es configuracion DEL AGENTE. Si lo ponés en un override
    // por sesión, se ignora silenciosamente.
    model: { id: 'claude-opus-5', effort: 'xhigh' },
    system: SYSTEM_PROMPT,
    // Toolset completo: bash, read, write, edit, glob, grep, web_fetch, web_search.
    tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: true } }],
  });
  console.log(`  ✓ ${agent.id} (version ${agent.version})`);

  console.log('\n─────────────────────────────────────────');
  console.log('Pegá esto en tu .env:\n');
  console.log(`AGENT_ID=${agent.id}`);
  console.log(`ENVIRONMENT_ID=${environment.id}`);
  console.log('─────────────────────────────────────────');
}

main().catch((err) => {
  if (err instanceof Anthropic.AuthenticationError) {
    console.error('✗ API key inválida o revocada.');
  } else if (err instanceof Anthropic.PermissionDeniedError) {
    console.error(
      '✗ 403 — tu cuenta no tiene acceso a Managed Agents (está en beta).\n' +
        '  Plan B: reescribimos esto con Claude Agent SDK, que corre en tu máquina.',
    );
  } else if (err instanceof Anthropic.NotFoundError) {
    console.error(
      '✗ 404 en un endpoint de Managed Agents — probablemente no esté habilitado\n' +
        '  en tu cuenta, o el SDK esté desactualizado. Probá: npm i @anthropic-ai/sdk@latest',
    );
  } else if (err instanceof Anthropic.APIError && err.status === 409) {
    console.error(
      `✗ Ya existe un environment llamado "${ENVIRONMENT_NAME}" (los nombres son únicos).\n` +
        '  Listalo y reusá su ID en vez de crear otro.',
    );
  } else if (err instanceof Anthropic.APIError) {
    console.error(`✗ API error ${err.status}: ${err.message}`);
  } else {
    console.error('✗', err);
  }
  process.exit(1);
});
