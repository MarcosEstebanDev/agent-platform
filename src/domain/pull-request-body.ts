import type { SkippedFile } from './ports/sandbox.port.js';

/**
 * El contenido del Pull Request. Dominio puro.
 *
 * Se arma desde la traza y nunca desde el texto del agente: es evidencia
 * verificable, no una narracion del modelo sobre si mismo (ADR 0007). Por eso
 * los eventos `text` se ignoran a proposito.
 */

/** Un evento tal como sale de la traza persistida: tipo + payload. */
export interface TraceEvent {
  type: string;
  payload: unknown;
}

export interface PullRequestBodyInput {
  ticket: { id: string; title: string; task: string };
  run: {
    id: string;
    model: string;
    iterations: number;
    inputTokens: number;
    outputTokens: number;
  };
  /** Rutas de lo que se commitea. */
  files: string[];
  skipped: SkippedFile[];
  events: TraceEvent[];
}

/** `feature/TICKET-<id>`, con sufijo cuando la rama ya existe y no es nuestra. */
export function branchFor(ticketId: string, attempt = 1): string {
  const base = `feature/TICKET-${ticketId}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const { ticket, run, files, skipped, events } = input;

  const lines = [`## ${ticket.title}`, '', ticket.task, '', '### Qué hizo el agente', ''];
  lines.push(`- ${files.length} ${files.length === 1 ? 'archivo escrito' : 'archivos escritos'}`);
  for (const command of commandsWithExitCode(events)) {
    lines.push(`- \`${command.command}\` → exit ${command.exitCode ?? '?'}`);
  }

  if (skipped.length > 0) {
    // Un PR incompleto sin explicacion es peor que uno que dice que falta.
    lines.push('', '### Quedó afuera del rescate', '');
    for (const s of skipped) lines.push(`- ${s.path} (${s.reason})`);
  }

  const tokens = run.inputTokens + run.outputTokens;
  lines.push(
    '',
    '---',
    `Ticket: ${ticket.id} · Corrida: ${run.id} · Modelo: ${run.model} · ` +
      `${run.iterations} iteraciones · ${formatTokens(tokens)} tokens`,
  );
  return lines.join('\n');
}

/**
 * Empareja cada `tool_call` de bash con el `tool_result` que le sigue.
 *
 * El exit code sale del preview (`exit code: N`), que es lo que el runner
 * registra como primera linea de la salida del comando.
 */
function commandsWithExitCode(
  events: TraceEvent[],
): Array<{ command: string; exitCode: number | null }> {
  const out: Array<{ command: string; exitCode: number | null }> = [];
  let pending: string | null = null;

  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === 'tool_call' && payload.name === 'bash') {
      const args = (payload.args ?? {}) as Record<string, unknown>;
      pending = typeof args.command === 'string' ? args.command : null;
    } else if (event.type === 'tool_result' && pending !== null) {
      const preview = typeof payload.preview === 'string' ? payload.preview : '';
      const match = /exit code: (-?\d+)/.exec(preview);
      out.push({ command: oneLine(pending), exitCode: match ? Number(match[1]) : null });
      pending = null;
    }
  }
  return out;
}

function oneLine(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
