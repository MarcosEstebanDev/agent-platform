import type {
  LlmMessage,
  LlmPort,
  LlmResponse,
  LlmStopReason,
  LlmToolDefinition,
} from '../../domain/ports/llm.port.js';

/**
 * Adapter para cualquier proveedor con API compatible con OpenAI.
 *
 * No está atado a ninguno: base URL, API key y modelo son configuración.
 * Probado contra Groq; sirve igual para OpenRouter, Cerebras, Mistral,
 * el endpoint OpenAI de Gemini, o un Ollama local.
 *
 * Esta generalización salió de que GitHub Models se retiró en julio 2026
 * mientras se estaba construyendo esto. Los proveedores gratis van y vienen;
 * la base URL tiene que ser un dato, no una constante.
 */

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiCompatibleConfig {
  /** Sin barra final. Ej: https://api.groq.com/openai/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAiCompatibleAdapter implements LlmPort {
  private readonly baseUrl: string;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  get modelName(): string {
    return this.config.model;
  }

  async complete(input: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
  }): Promise<LlmResponse> {
    const res = await this.post('/chat/completions', {
      model: this.config.model,
      messages: input.messages.map(toWireMessage),
      tools: input.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: 'auto',
    });

    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    if (!choice) throw new Error('El proveedor devolvió una respuesta sin choices');

    return {
      text: choice.message?.content ?? null,
      toolCalls: (choice.message?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        // `arguments` viene como string JSON. Si el modelo lo emite mal,
        // preferimos un objeto vacío antes que romper el loop entero.
        arguments: safeParseArgs(tc.function.arguments),
      })),
      stopReason: mapStopReason(choice.finish_reason),
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  /** Lista los modelos que la API key puede usar. Sirve para no adivinar IDs. */
  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (!res.ok) throw new Error(`GET /models → ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id).sort();
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res;

    const text = await res.text();
    const hint = errorHint(res.status, this.config.model);
    throw new Error(`${this.baseUrl} → ${res.status}${hint}\n${text}`);
  }
}

function errorHint(status: number, model: string): string {
  switch (status) {
    case 401:
    case 403:
      return ': API key inválida o sin permisos.';
    case 404:
      return `: el modelo "${model}" no existe en este proveedor. Corré "npm run models" para ver los disponibles.`;
    case 410:
      return ': el endpoint fue retirado. Hay que cambiar de proveedor.';
    case 429:
      return ': límite de rate del free tier alcanzado. Esperá o bajá la frecuencia.';
    default:
      return '';
  }
}

function toWireMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function mapStopReason(reason: string | undefined): LlmStopReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'other';
  }
}
