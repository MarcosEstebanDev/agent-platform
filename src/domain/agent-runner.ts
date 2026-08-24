import type {
  LlmMessage,
  LlmPort,
  LlmToolDefinition,
} from './ports/llm.port.js';
import type { SandboxPort } from './ports/sandbox.port.js';

/**
 * El loop del agente. Dominio puro: sólo depende de los dos puertos.
 *
 * Emite eventos en vez de imprimir. Hoy los consume un console.log en run.ts;
 * en la fase 1 los va a consumir la máquina de estados del ticket sin que
 * este archivo cambie.
 */

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | {
      type: 'done';
      reason: AgentStopReason;
      /** Cual de los tres presupuestos se agoto. Solo en 'budget_exceeded'. */
      budget?: ExceededBudget;
    }
  /**
   * Rescate del trabajo antes de destruir el sandbox.
   *
   * Lo emite el caso de uso, no el agente: el agente no sabe que su entorno
   * es efimero. Vive igual en la traza porque "que sobrevivio de esta
   * corrida" es parte de su historia, y es lo unico que explica un PR vacio.
   */
  | {
      type: 'artifact';
      files: number;
      bytes: number;
      truncated: boolean;
      /** Presente solo si la extraccion fallo. La corrida no se cae por esto. */
      error?: string;
    };

export type AgentStopReason = 'completed' | 'max_iterations' | 'budget_exceeded';

export type ExceededBudget = 'wall_clock' | 'tokens';

/**
 * Tres limites independientes: el que se agote primero corta la corrida.
 *
 * Son tres y no uno porque miden cosas distintas. Un agente enroscado en un
 * loop corto agota iteraciones; uno esperando un comando lento agota tiempo;
 * uno arrastrando un transcript gigante agota tokens. Cubrir solo uno deja
 * las otras dos formas de quemar plata abiertas.
 */
export interface AgentBudget {
  maxIterations: number;
  maxWallClockMs: number;
  maxTokens: number;
}

export const DEFAULT_BUDGET: AgentBudget = {
  maxIterations: 25,
  maxWallClockMs: 10 * 60_000,
  maxTokens: 100_000,
};

export interface AgentResult {
  reason: AgentStopReason;
  budget?: ExceededBudget;
  iterations: number;
  usage: { input: number; output: number };
  transcript: LlmMessage[];
}

const SYSTEM_PROMPT = `Sos un agente de desarrollo que trabaja dentro de un container Linux aislado.
El directorio de trabajo es /workspace.

Reglas:
- Verificá tu trabajo ejecutando los tests antes de dar la tarea por terminada.
- Reportá el resultado con honestidad: si los tests fallan, decilo y pegá la salida real.
- No agregues features, abstracciones ni refactors más allá de lo que la tarea pide.
- No pidas permiso ni confirmación: trabajás de forma autónoma, nadie va a responderte.
- Antes de terminar, revisá tu último mensaje: si es un plan o una promesa de trabajo
  que todavía no hiciste, hacelo ahora con tool calls en vez de anunciarlo.`;

const TOOLS: LlmToolDefinition[] = [
  {
    name: 'bash',
    description:
      'Ejecuta un comando de shell en /workspace dentro del container. ' +
      'Devuelve stdout, stderr y el exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'El comando a ejecutar' },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_file',
    description: 'Escribe un archivo, creando los directorios que falten.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta absoluta, ej: /workspace/index.js' },
        content: { type: 'string', description: 'Contenido completo del archivo' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta absoluta del archivo' },
      },
      required: ['path'],
    },
  },
];

export class AgentRunner {
  private readonly budget: AgentBudget;

  constructor(
    private readonly llm: LlmPort,
    private readonly sandbox: SandboxPort,
    budget: Partial<AgentBudget> = {},
    /** Inyectable para poder testear el corte por tiempo sin esperar 10 minutos. */
    private readonly now: () => number = Date.now,
  ) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  async run(
    task: string,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentResult> {
    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: task },
    ];
    const usage = { input: 0, output: 0 };
    const startedAt = this.now();

    for (let i = 1; i <= this.budget.maxIterations; i++) {
      // El corte por tiempo se chequea ANTES de gastar otra llamada, no despues:
      // no tiene sentido pagar un request cuyo resultado ya no se va a usar.
      if (this.now() - startedAt >= this.budget.maxWallClockMs) {
        return this.cutByBudget('wall_clock', i - 1, usage, messages, onEvent);
      }

      const res = await this.llm.complete({ messages, tools: TOOLS });
      usage.input += res.usage.input;
      usage.output += res.usage.output;

      messages.push({
        role: 'assistant',
        content: res.text,
        toolCalls: res.toolCalls.length > 0 ? res.toolCalls : undefined,
      });

      if (res.text) onEvent({ type: 'text', text: res.text });

      // Sin tool calls, el agente terminó su turno.
      if (res.toolCalls.length === 0) {
        onEvent({ type: 'done', reason: 'completed' });
        return { reason: 'completed', iterations: i, usage, transcript: messages };
      }

      // Se chequea despues del corte por 'completed': si el agente ya termino,
      // haber pasado el techo de tokens no convierte un exito en una falla.
      if (usage.input + usage.output >= this.budget.maxTokens) {
        return this.cutByBudget('tokens', i, usage, messages, onEvent);
      }

      // El protocolo exige una respuesta por CADA tool call. Si falta una,
      // el proveedor rechaza el request siguiente.
      for (const call of res.toolCalls) {
        onEvent({ type: 'tool_call', name: call.name, args: call.arguments });

        const output = await this.executeTool(call.name, call.arguments);

        onEvent({
          type: 'tool_result',
          name: call.name,
          ok: output.ok,
          preview: output.text.slice(0, 200),
        });

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: output.text,
        });
      }
    }

    onEvent({ type: 'done', reason: 'max_iterations' });
    return {
      reason: 'max_iterations',
      iterations: this.budget.maxIterations,
      usage,
      transcript: messages,
    };
  }

  /**
   * Cortar por presupuesto NO es un error del agente: es una decision del
   * orquestador. Por eso emite un 'done' con motivo, y no lanza.
   */
  private cutByBudget(
    budget: ExceededBudget,
    iterations: number,
    usage: { input: number; output: number },
    transcript: LlmMessage[],
    onEvent: (event: AgentEvent) => void,
  ): AgentResult {
    onEvent({ type: 'done', reason: 'budget_exceeded', budget });
    return { reason: 'budget_exceeded', budget, iterations, usage, transcript };
  }

  /**
   * Los errores de tool NO se propagan como excepción: se devuelven como texto
   * para que el modelo los lea y corrija el rumbo. Un throw acá mataría el loop
   * por un typo en un comando.
   */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
    try {
      switch (name) {
        case 'bash': {
          const r = await this.sandbox.exec(String(args.command ?? ''));
          const parts = [`exit code: ${r.exitCode}`];
          if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout}`);
          if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr}`);
          return { ok: r.exitCode === 0, text: parts.join('\n') };
        }
        case 'write_file': {
          await this.sandbox.writeFile(String(args.path), String(args.content ?? ''));
          return { ok: true, text: `Escrito: ${args.path}` };
        }
        case 'read_file': {
          const content = await this.sandbox.readFile(String(args.path));
          return { ok: true, text: content };
        }
        default:
          return { ok: false, text: `Error: tool desconocida "${name}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, text: `Error ejecutando ${name}: ${msg}` };
    }
  }
}
