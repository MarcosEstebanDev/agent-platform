import { NewTicketForm } from '@/components/new-ticket-form';
import { ApiUnreachableError, listTickets, STATUSES, type Ticket } from '@/lib/api';

// El tablero refleja estado que cambia solo (los workers mueven tickets sin
// que nadie navegue). Cachearlo mostraria un tablero viejo con cara de actual.
export const dynamic = 'force-dynamic';

export default async function Home() {
  let tickets: Ticket[] = [];
  let error: string | null = null;

  try {
    tickets = await listTickets();
  } catch (err) {
    error =
      err instanceof ApiUnreachableError
        ? 'La API no responde. Levantala con "npm run api" (y "npm run db:up" antes).'
        : err instanceof Error
          ? err.message
          : String(err);
  }

  return (
    <>
      <h1>Tickets</h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
        Un ticket es una instruccion para un agente. El orquestador lo encola, un
        worker lo ejecuta en un container aislado, y todo queda registrado.
      </p>

      <NewTicketForm />

      {error ? <p className="error-box">{error}</p> : null}

      <div className="board">
        {STATUSES.map((status) => {
          const columna = tickets.filter((t) => t.status === status);
          return (
            <div className="column" key={status}>
              <div className="column-head">
                <span>{status}</span>
                <span>{columna.length}</span>
              </div>
              <div className="column-body">
                {columna.map((ticket) => (
                  <a
                    className="card"
                    data-status={ticket.status}
                    href={`/tickets/${ticket.id}`}
                    key={ticket.id}
                  >
                    <div className="card-title">{ticket.title}</div>
                    <div className="card-meta">
                      {ticket.id.slice(0, 8)} · {formatoRelativo(ticket.updatedAt)}
                    </div>
                  </a>
                ))}
                {columna.length === 0 ? <div className="empty">vacio</div> : null}
              </div>
            </div>
          );
        })}
      </div>

      {tickets.length === 0 && !error ? (
        <>
          <h2>Todavia no hay tickets</h2>
          <div className="panel">
            <p className="muted" style={{ marginTop: 0 }}>
              Crea uno arriba. Para que se ejecute hacen falta tres procesos:
            </p>
            <pre className="task-box">
              {'npm run db:up   # Postgres + Redis\nnpm run api     # esta API\nnpm run worker  # el que corre los agentes'}
            </pre>
          </div>
        </>
      ) : null}
    </>
  );
}

function formatoRelativo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'recien';
  if (min < 60) return `hace ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `hace ${horas} h`;
  return `hace ${Math.floor(horas / 24)} d`;
}
