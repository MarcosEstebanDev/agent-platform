import { notFound } from 'next/navigation';
import { StatusBadge } from '@/components/badges';
import { RunButton } from '@/components/run-button';
import { RunsPanel } from '@/components/runs-panel';
import {
  ApiUnreachableError,
  getTicket,
  isRunnable,
  listRuns,
  type AgentRun,
  type Ticket,
} from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let ticket: Ticket;
  let runs: AgentRun[] = [];

  try {
    ticket = await getTicket(id);
    runs = await listRuns(id);
  } catch (err) {
    if (err instanceof ApiUnreachableError) {
      return (
        <p className="error-box">
          La API no responde. Levantala con &quot;npm run api&quot;.
        </p>
      );
    }
    // Cualquier otro fallo de lectura aca es, en la practica, un 404.
    notFound();
  }

  const enCurso = ticket.status === 'IN_PROGRESS' || ticket.status === 'ASSIGNED';

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        <a href="/">← tickets</a>
      </p>

      <div className="detail-head">
        <div>
          <h1>{ticket.title}</h1>
          <p className="card-meta">
            {ticket.id} · creado {new Date(ticket.createdAt).toLocaleString('es')}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatusBadge status={ticket.status} />
          {isRunnable(ticket.status) ? (
            <RunButton id={ticket.id} reintento={ticket.status === 'FAILED'} />
          ) : null}
        </div>
      </div>

      {ticket.prUrl || ticket.statusReason ? (
        <>
          <h2>Entrega</h2>
          <p className="card-meta">
            {ticket.prUrl ? (
              <a href={ticket.prUrl} target="_blank" rel="noreferrer">
                PR #{ticket.prNumber}
              </a>
            ) : null}
            {ticket.branch ? ` · ${ticket.branch}` : ''}
            {ticket.gateAttempts > 0 ? ` · ${ticket.gateAttempts} rechazo(s) de CI` : ''}
          </p>
          {ticket.statusReason ? <p className="error-box">{ticket.statusReason}</p> : null}
        </>
      ) : null}

      <h2>Instruccion del agente</h2>
      <pre className="task-box">{ticket.task}</pre>

      {ticket.gateFeedback ? (
        <>
          <h2>Feedback de CI para el proximo intento</h2>
          <pre className="task-box">{ticket.gateFeedback}</pre>
        </>
      ) : null}

      <h2>Corridas</h2>
      <RunsPanel ticketId={ticket.id} runs={runs} live={enCurso} />
    </>
  );
}
