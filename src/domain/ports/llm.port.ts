/**
 * Puerto de LLM. El dominio no sabe qué proveedor hay del otro lado.
 *
 * Cambiar de GitHub Models a Gemini, a Anthropic o a un modelo local
 * es escribir otro adapter, no tocar el loop del agente.
 */

export interface LlmToolCall {
  /** ID que asigna el proveedor. Hay que devolverlo con el resultado. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Sólo en mensajes 'assistant'. */
  toolCalls?: LlmToolCall[];
  /** Sólo en mensajes 'tool'. Referencia al LlmToolCall.id que responde. */
  toolCallId?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema de los parámetros. */
  parameters: Record<string, unknown>;
}

export type LlmStopReason = 'stop' | 'tool_calls' | 'length' | 'other';

export interface LlmResponse {
  text: string | null;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: { input: number; output: number };
}

export interface LlmPort {
  /** Nombre legible del modelo, para logs y trazas. */
  readonly modelName: string;

  complete(input: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
  }): Promise<LlmResponse>;
}
