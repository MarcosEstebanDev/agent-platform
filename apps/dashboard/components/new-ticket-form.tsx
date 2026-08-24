'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { createTicket, type ActionState } from '@/app/actions';

function SubmitButton() {
  // useFormStatus solo funciona en un hijo del <form>, no en el mismo
  // componente que lo declara.
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? 'Creando...' : 'Crear ticket'}
    </button>
  );
}

export function NewTicketForm() {
  const [state, action] = useActionState<ActionState, FormData>(createTicket, {});

  return (
    <form action={action} className="new-ticket">
      {state.error ? <p className="error-box">{state.error}</p> : null}
      <input name="title" placeholder="Titulo (para humanos)" maxLength={200} />
      <textarea
        name="task"
        placeholder={
          'La instruccion que recibe el agente. Es literalmente el prompt.\n\n' +
          'Ej: Crea calculator.mjs con divide(a,b) que lance Error si b es 0, ' +
          'sus tests con node:test, y ejecuta node --test.'
        }
        rows={5}
      />
      <SubmitButton />
    </form>
  );
}
