import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { EvaluateGatesUseCase } from '../application/evaluate-gates.use-case.js';
import type { OpenPullRequestUseCase } from '../application/open-pull-request.use-case.js';
import type { TicketRepositoryPort } from '../domain/ports/ticket-repository.port.js';
import type { GitHubConfig } from '../config.js';
import {
  pullRequestsFromCheckSuite,
  verifySignature,
} from '../infrastructure/github/webhook.js';
import { EVALUATE_GATES, GITHUB_CONFIG, OPEN_PULL_REQUEST, TICKET_REPOSITORY } from './tokens.js';

/**
 * Lo que la API hace con GitHub: recibir el webhook de CI y reintentar un PR.
 *
 * Nada de esto ejecuta al agente (ADR 0009). Son llamadas HTTP cortas a
 * GitHub: abrir un PR con un trabajo que ya existe, o leer el estado de unos
 * checks.
 *
 * Sin GITHUB_TOKEN la API arranca igual y estas rutas responden 503: la API
 * no deberia depender de GitHub para listar tickets.
 */
@Controller()
export class GitHubController {
  constructor(
    @Inject(TICKET_REPOSITORY) private readonly tickets: TicketRepositoryPort,
    @Inject(GITHUB_CONFIG) private readonly config: GitHubConfig | null,
    @Inject(OPEN_PULL_REQUEST) private readonly openPullRequest: OpenPullRequestUseCase | null,
    @Inject(EVALUATE_GATES) private readonly evaluateGates: EvaluateGatesUseCase | null,
  ) {}

  /**
   * Webhook de GitHub. Camino principal de los gates: sin latencia.
   *
   * Responde 202 aunque la evaluacion falle: GitHub reintenta los webhooks
   * que no reciben 2xx, y un reintento no arregla un 502 de su propia API.
   * Lo que no se evalue aca lo levanta el poller del worker.
   */
  @Post('webhooks/github')
  @HttpCode(202)
  async webhook(
    // Solo se usan body y rawBody: tipar la request de Express entera pediria
    // @types/express como dependencia por dos campos.
    @Req() req: RawBodyRequest<{ body: unknown }>,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    const secret = this.config?.webhookSecret;
    if (!secret || !this.evaluateGates) {
      throw new ServiceUnavailableException(
        'Webhook deshabilitado: faltan GITHUB_TOKEN o GITHUB_WEBHOOK_SECRET. El poller cubre igual.',
      );
    }
    if (!req.rawBody || !verifySignature(req.rawBody, signature, secret)) {
      throw new UnauthorizedException('Firma invalida');
    }

    const evaluated: Array<{ ticketId: string; outcome: string }> = [];
    for (const prNumber of pullRequestsFromCheckSuite(event, req.body)) {
      const ticket = await this.tickets.findByPullRequest(prNumber);
      if (!ticket) continue;
      try {
        const result = await this.evaluateGates.execute(ticket.id);
        evaluated.push({ ticketId: result.ticketId, outcome: result.outcome });
      } catch (err) {
        evaluated.push({
          ticketId: ticket.id,
          outcome: `error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return { evaluated };
  }

  /**
   * Reintenta el PR de un ticket que quedo en IN_PROGRESS porque el push o el
   * PR fallaron. Usa el trabajo ya rescatado: no reejecuta al agente.
   */
  @Post('tickets/:id/pull-request')
  async retryPullRequest(@Param('id') id: string) {
    if (!this.openPullRequest) throw new ServiceUnavailableException('Falta GITHUB_TOKEN');

    const result = await this.openPullRequest.execute(id);
    if (result.ok) {
      return { ticketId: id, status: result.ticket.status, pullRequest: result.pullRequest };
    }
    switch (result.reason) {
      case 'not_found':
        throw new NotFoundException(result.detail);
      case 'push_failed':
      case 'pr_failed':
        throw new ServiceUnavailableException(result.detail);
      case 'invalid_status':
        throw new ConflictException(result.detail);
      default:
        throw new BadRequestException(result.detail);
    }
  }

  /** Evalua los gates de un ticket ya, sin esperar al webhook ni al poller. */
  @Post('tickets/:id/gates')
  async evaluate(@Param('id') id: string) {
    if (!this.evaluateGates) throw new ServiceUnavailableException('Falta GITHUB_TOKEN');
    if (!(await this.tickets.findById(id))) throw new NotFoundException(`No existe el ticket ${id}`);
    return this.evaluateGates.execute(id);
  }
}
