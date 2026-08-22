/**
 * Lista los modelos que tu API key puede usar.
 *
 * Existe porque adivinar IDs de modelo es la forma más rápida de perder
 * media hora contra un 404.
 */
import { OpenAiCompatibleAdapter } from './infrastructure/llm/openai-compatible.adapter.js';

const { LLM_BASE_URL, LLM_API_KEY } = process.env;

if (!LLM_BASE_URL || !LLM_API_KEY || LLM_API_KEY === 'PEGA_TU_API_KEY_ACA') {
  console.error('✗ Faltan LLM_BASE_URL / LLM_API_KEY en .env');
  process.exit(1);
}

const llm = new OpenAiCompatibleAdapter({
  baseUrl: LLM_BASE_URL,
  apiKey: LLM_API_KEY,
  model: '(no aplica)',
});

const models = await llm.listModels();
console.log(`${models.length} modelos disponibles en ${LLM_BASE_URL}:\n`);
for (const id of models) console.log(`  ${id}`);
console.log('\nCopiá el que quieras a LLM_MODEL en .env');
