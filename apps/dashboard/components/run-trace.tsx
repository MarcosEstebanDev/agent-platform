'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentEventRecord } from '@/lib/api';

/**
 * La traza de una corrida, en vivo.
 *
 * Pide solo los eventos posteriores al ultimo `seq` que ya tiene: la traza es
 * append-only, asi que traerla entera en cada tick seria pedir cientos de
 * filas -algunas con archivos completos adentro- para agregar dos lineas.
 */
export function RunTrace({
  ticketId,
  runId,
  live,
}: {
  ticketId: string;
  runId: string;
  live: boolean;
}) {
  const [events, setEvents] = useState<AgentEventRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const caja = useRef<HTMLDivElement>(null);
  const pegadoAbajo = useRef(true);

  useEffect(() => {
    // Cambio de corrida: se descarta lo anterior o se mezclarian dos trazas.
    setEvents([]);
    setError(null);

    let cancelado = false;
    let ultimo = -1;

    async function traer(): Promise<void> {
      try {
        const query = ultimo >= 0 ? `?after=${ultimo}` : '';
        const res = await fetch(`/api/tickets/${ticketId}/runs/${runId}/events${query}`);
        if (!res.ok) throw new Error(`${res.status}`);

        const nuevos = (await res.json()) as AgentEventRecord[];
        if (cancelado || nuevos.length === 0) return;

        ultimo = nuevos[nuevos.length - 1]!.seq;
        setEvents((previos) => [...previos, ...nuevos]);
        setError(null);
      } catch {
        if (!cancelado) setError('No se pudo leer la traza.');
      }
    }

    void traer();
    if (!live) return () => void (cancelado = true);

    const timer = setInterval(() => void traer(), 1500);
    return () => {
      cancelado = true;
      clearInterval(timer);
    };
  }, [ticketId, runId, live]);

  // Autoscroll, pero solo si el usuario ya estaba al final. Arrastrarlo hacia
  // abajo mientras lee algo de arriba es la forma mas rapida de arruinar un
  // visor de logs.
  useEffect(() => {
    const el = caja.current;
    if (el && pegadoAbajo.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  function alScrollear(): void {
    const el = caja.current;
    if (!el) return;
    pegadoAbajo.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  if (events.length === 0) {
    return (
      <div className="empty">
        {error ?? (live ? 'Esperando los primeros eventos...' : 'Esta corrida no dejo traza.')}
      </div>
    );
  }

  return (
    <div className="trace" ref={caja} onScroll={alScrollear}>
      {events.map((ev) => (
        <Evento key={ev.seq} ev={ev} />
      ))}
      {error ? <div className="ev ev-fail">{error}</div> : null}
    </div>
  );
}

function Evento({ ev }: { ev: AgentEventRecord }) {
  const p = ev.payload;

  switch (ev.type) {
    case 'text':
      return (
        <div className="ev">
          <span className="ev-seq">{ev.seq}</span>
          <span className="ev-text">{String(p.text ?? '')}</span>
        </div>
      );

    case 'tool_call': {
      const args = (p.args ?? {}) as Record<string, unknown>;
      const detalle = String(args.command ?? args.path ?? '');
      return (
        <div className="ev">
          <span className="ev-seq">{ev.seq}</span>
          <span className="ev-call">
            ▸ {String(p.name ?? '')} {detalle}
          </span>
        </div>
      );
    }

    case 'tool_result': {
      const ok = p.ok === true;
      return (
        <div className="ev">
          <span className="ev-seq">{ev.seq}</span>
          <span className={ok ? 'ev-ok' : 'ev-fail'}>
            {ok ? '✓' : '✗'} {String(p.preview ?? '').replace(/\n/g, ' ⏎ ')}
          </span>
        </div>
      );
    }

    case 'done': {
      const razon = String(p.reason ?? '');
      const presupuesto = p.budget ? ` (${String(p.budget)})` : '';
      return (
        <div className="ev ev-done">
          <span className="ev-seq">{ev.seq}</span>
          <span className={razon === 'completed' ? 'ev-ok' : 'ev-fail'}>
            ■ {razon}
            {presupuesto}
          </span>
        </div>
      );
    }

    default:
      return null;
  }
}
