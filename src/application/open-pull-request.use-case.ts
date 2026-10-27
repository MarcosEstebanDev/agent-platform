import { branchFor, buildPullRequestBody } from '../domain/pull-request-body.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';
import { VcsError, type PullRequestRef, type VcsPort } from '../domain/ports/vcs.port.js';
import type { Ticket } from '../domain/ticket.js';

export interface DeliveryConfig {
  /** `owner/nombre`. Hoy hay un solo repo destino, configurado por entorno. */
  repo: string;
  /** Rama contra la que se abre el PR. */
  base: string;
  /**
   * Valores que nunca pueden terminar persistidos (el PAT). Se tachan de
   * cualquier mensaje de error antes de guardarlo: la defensa no puede
   * depender de que cada adapter se acuerde de no filtrar.
   */
  secrets?: readonly string[];
  /** Cuantos sufijos se prueban si la rama ya existe. */
  maxBranchAttempts?: number;
}

export type OpenPullRequestResult =
  | { ok: true; ticket: Ticket; pullRequest: PullRequestRef; branch: string }
  | {
      ok: false;
      /**
       * - `push_failed` / `pr_failed`: el ticket queda IN_PROGRESS y se
       *   reintenta sin reejecutar al agente.
       * - `forbidden` / `no_artifact`: el ticket pasa a FAILED. Reintentar sin
       *   que cambie algo afuera daria el mismo resultado.
       */
      reason:
        | 'not_found'
        | 'invalid_status'
        | 'no_artifact'
        | 'forbidden'
        | 'push_failed'
        | 'pr_failed';
      detail: string;
    };

/**
 * Lleva el trabajo rescatado de una corrida a un Pull Request.
 *
 * Esta separado de `RunTicketUseCase` porque tiene que poder correr solo: si
 * el push salio y el PR fallo, reintentar NO puede volver a gastar tokens del
 * LLM. El trabajo del agente ya esta en `run_artifacts`; lo que falta es
 * entregarlo.
 */
export class OpenPullRequestUseCase {
  constructor(
    private readonly tickets: TicketRepositoryPort,
    private readonly vcs: VcsPort,
    private readonly config: DeliveryConfig,
  ) {}

  /** El repo existe y el token lo ve. Se llama antes de gastar tokens. */
  async preflight(): Promise<void> {
    try {
      await this.vcs.checkAccess(this.config.repo);
    } catch (err) {
      throw new Error(this.redact(message(err)));
    }
  }

  async execute(ticketId: string, runId?: string): Promise<OpenPullRequestResult> {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) {
      return { ok: false, reason: 'not_found', detail: `No existe el ticket ${ticketId}` };
    }
    if (ticket.status !== 'IN_PROGRESS') {
      return {
        ok: false,
        reason: 'invalid_status',
        detail: `El ticket esta en ${ticket.status}; solo se abre PR desde IN_PROGRESS`,
      };
    }

    const runs = await this.tickets.listRuns(ticketId);
    // La ultima por fecha y no la primera de la lista: el orden del listado
    // es un detalle del repositorio, no parte del contrato.
    const run = runId
      ? runs.find((r) => r.id === runId)
      : [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    const artifact = run ? await this.tickets.getRunArtifact(run.id) : null;

    // ADR 0010 lo anticipaba: el rescate informa, el flujo del PR decide. Y
    // sin archivos no hay nada que proponer.
    if (!run || !artifact || artifact.files.length === 0) {
      return this.fail(
        ticket,
        'no_artifact',
        'Sin artefacto: la corrida no dejo archivos que commitear (mira la traza).',
      );
    }

    // ─── 1. Push ────────────────────────────────────────────────────────────
    const files = artifact.files.map((f) => ({ path: f.path, content: f.content }));
    const commitMessage = `TICKET-${ticket.id}: ${ticket.title}\n\nCorrida ${run.id} (${run.model})`;
    let branch = ticket.branch;

    // Con la rama ya guardada hay dos casos, y ninguno vuelve a crearla:
    // - sin PR todavia: es un reintento del PR, el commit ya esta y se saltea;
    // - con PR: es un ciclo de correccion (spec 004). Se suma un commit a la
    //   misma rama y el PR abierto se actualiza solo, CI incluido.
    const alreadyPushed = branch !== null && ticket.prNumber === null;

    try {
      if (branch === null) {
        branch = await this.pushNewBranch(ticket.id, commitMessage, files);
        // Se guarda YA, antes del PR. Es lo que permite reintentar el PR sin
        // reejecutar al agente.
        await this.tickets.updateDelivery(ticket.id, { branch });
      } else if (!alreadyPushed) {
        await this.vcs.commitFiles({
          repo: this.config.repo,
          branch,
          base: this.config.base,
          message: commitMessage,
          files,
          createOnly: false,
        });
      }
    } catch (err) {
      if (err instanceof VcsError && (err.kind === 'forbidden' || err.kind === 'not_found')) {
        return this.fail(ticket, 'forbidden', this.redact(err.message));
      }
      const detail = this.redact(`No se pudo pushear: ${message(err)}`);
      await this.tickets.updateDelivery(ticket.id, { statusReason: detail });
      return { ok: false, reason: 'push_failed', detail };
    }

    // ─── 2. Pull Request ────────────────────────────────────────────────────
    let pullRequest: PullRequestRef;
    try {
      pullRequest =
        (await this.vcs.findOpenPullRequest(this.config.repo, branch)) ??
        (await this.vcs.openPullRequest({
          repo: this.config.repo,
          branch,
          base: this.config.base,
          title: ticket.title,
          body: buildPullRequestBody({
            ticket,
            run,
            files: files.map((f) => f.path),
            skipped: artifact.skipped,
            events: await this.tickets.listEvents(run.id, { limit: 500 }),
          }),
        }));
    } catch (err) {
      // El push salio: el ticket queda IN_PROGRESS con la rama guardada. Es
      // la fila "PR falla pero el push salio" de la spec 003.
      const detail = this.redact(`PR no abierto: ${message(err)}`);
      await this.tickets.updateDelivery(ticket.id, { statusReason: detail });
      return { ok: false, reason: 'pr_failed', detail };
    }

    await this.tickets.updateDelivery(ticket.id, {
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
      statusReason: null,
      checksStartedAt: null,
    });
    const opened = await this.tickets.transition(ticket.id, 'IN_PROGRESS', 'PR_OPEN');
    if (!opened) {
      return {
        ok: false,
        reason: 'invalid_status',
        detail: 'Otro proceso movio el ticket mientras se abria el PR',
      };
    }
    return { ok: true, ticket: opened, pullRequest, branch };
  }

  /** `feature/TICKET-<id>`, y si ya existe y no es nuestra, `-2`, `-3`... */
  private async pushNewBranch(
    ticketId: string,
    commitMessage: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<string> {
    const max = this.config.maxBranchAttempts ?? 5;
    for (let attempt = 1; ; attempt++) {
      const branch = branchFor(ticketId, attempt);
      try {
        await this.vcs.commitFiles({
          repo: this.config.repo,
          branch,
          base: this.config.base,
          message: commitMessage,
          files,
          createOnly: true,
        });
        return branch;
      } catch (err) {
        if (!(err instanceof VcsError && err.kind === 'branch_exists') || attempt >= max) {
          throw err;
        }
      }
    }
  }

  private async fail(
    ticket: Ticket,
    reason: 'no_artifact' | 'forbidden',
    detail: string,
  ): Promise<OpenPullRequestResult> {
    await this.tickets.updateDelivery(ticket.id, { statusReason: detail });
    await this.tickets.transition(ticket.id, 'IN_PROGRESS', 'FAILED');
    return { ok: false, reason, detail };
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.config.secrets ?? []) {
      if (secret) out = out.split(secret).join('***');
    }
    return out;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
