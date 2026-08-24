'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { runTicket, type ActionState } from '@/app/actions';

function Submit({ etiqueta }: { etiqueta: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? 'Encolando...' : etiqueta}
    </button>
  );
}

/**
 * Dispara la corrida. El boton dice "Encolar" y no "Ejecutar" a proposito:
 * la API responde 202 y no ejecuta nada; el trabajo lo toma un worker cuando
 * puede. Prometer ejecucion inmediata seria mentirle al usuario sobre lo que
 * acaba de pasar.
 */
export function RunButton({ id, reintento }: { id: string; reintento: boolean }) {
  const [state, action] = useActionState<ActionState, FormData>(runTicket, {});

  return (
    <div>
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <Submit etiqueta={reintento ? 'Reintentar' : 'Encolar corrida'} />
      </form>
      {state.error ? (
        <p className="error-box" style={{ marginTop: 10, marginBottom: 0 }}>
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
