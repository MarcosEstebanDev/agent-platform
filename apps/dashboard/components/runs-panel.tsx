'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { durationOf, tokensOf, type AgentRun } from '@/lib/api';
import { OutcomeBadge } from '@/components/badges';
import { RunTrace } from '@/components/run-trace';

/**
 * Lista de corridas + traza de la seleccionada.
 *
 * Es cliente y no servidor porque "que corrida estoy mirando" es estado de la
 * UI: meterlo en la URL obligaria a un round-trip para cambiar de pestana.
 */
export function RunsPanel({
  ticketId,
  runs,
  live,
}: {
  ticketId: string;
  runs: AgentRun[];
  live: boolean;
}) {
  const router = useRouter();
  const [seleccionada, setSeleccionada] = useState<string | null>(runs[0]?.id ?? null);

  // Cuando llega una corrida nueva (el worker acaba de tomar el ticket), se
  // salta a ella: es lo que el usuario vino a mirar.
  useEffect(() => {
    if (runs.length > 0 && !runs.some((r) => r.id === seleccionada)) {
      setSeleccionada(runs[0]!.id);
    }
  }, [runs, seleccionada]);

  // Refresco del lado servidor mientras algo corre: trae corridas nuevas y el
  // estado del ticket. La traza se actualiza sola, aparte y mas seguido.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [live, router]);

  if (runs.length === 0) {
    return (
      <div className="empty">
        Todavia no corrio nunca. Dale a Ejecutar (necesita Redis y el worker arriba).
      </div>
    );
  }

  const corrida = runs.find((r) => r.id === seleccionada) ?? runs[0]!;

  return (
    <>
      <div className="runs">
        {runs.map((run) => (
          <button
            className="run"
            data-selected={run.id === corrida.id}
            key={run.id}
            onClick={() => setSeleccionada(run.id)}
            type="button"
          >
            <OutcomeBadge outcome={run.outcome} />
            <span className="run-stat">{run.model}</span>
            <span className="run-stat">{run.iterations} iter</span>
            <span className="run-stat">{tokensOf(run).toLocaleString('es')} tokens</span>
            <span className="run-stat">{durationOf(run)}</span>
            <span className="run-stat" style={{ marginLeft: 'auto' }}>
              {new Date(run.startedAt).toLocaleString('es')}
            </span>
          </button>
        ))}
      </div>

      {corrida.error ? <p className="error-box">{corrida.error}</p> : null}

      <h2>Traza</h2>
      <RunTrace
        ticketId={ticketId}
        runId={corrida.id}
        live={live && corrida.finishedAt === null}
      />
    </>
  );
}
