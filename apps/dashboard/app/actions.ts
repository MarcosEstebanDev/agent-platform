'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { API_URL, ApiUnreachableError, type Ticket } from '@/lib/api';

/**
 * Server Actions: las escrituras salen del servidor de Next, no del navegador.
 *
 * Consecuencia practica: la API nunca queda expuesta al cliente. El dia que
 * tenga auth, el token vive aca y no en el bundle.
 */

export interface ActionState {
  error?: string;
}

async function post(path: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiUnreachableError(API_URL);
  }
}

export async function createTicket(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const title = String(formData.get('title') ?? '').trim();
  const task = String(formData.get('task') ?? '').trim();

  if (!title || !task) return { error: 'Titulo y tarea son obligatorios.' };

  let ticket: Ticket;
  try {
    const res = await post('/tickets', { title, task });
    if (!res.ok) return { error: `La API respondio ${res.status}: ${await res.text()}` };
    ticket = (await res.json()) as Ticket;
  } catch (err) {
    return { error: mensaje(err) };
  }

  // redirect() lanza: tiene que quedar FUERA del try o el catch se lo come y
  // la navegacion nunca ocurre.
  revalidatePath('/');
  redirect(`/tickets/${ticket.id}`);
}

export async function runTicket(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get('id') ?? '');

  try {
    const res = await post(`/tickets/${id}/run`);

    // 503 significa "la cola no responde, volve a intentar", no "no sirve".
    // Merece un mensaje distinto porque la accion del usuario es distinta.
    if (res.status === 503) {
      return { error: 'La cola no responde. Levanta Redis (npm run db:up) y reintenta.' };
    }
    if (!res.ok) return { error: `La API respondio ${res.status}: ${await res.text()}` };
  } catch (err) {
    return { error: mensaje(err) };
  }

  revalidatePath(`/tickets/${id}`);
  revalidatePath('/');
  return {};
}

function mensaje(err: unknown): string {
  if (err instanceof ApiUnreachableError) {
    return `No se puede alcanzar la API en ${API_URL}. Levantala con "npm run api".`;
  }
  return err instanceof Error ? err.message : String(err);
}
