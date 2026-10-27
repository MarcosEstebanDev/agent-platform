import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhooks de GitHub: verificar que vienen de GitHub y extraer que PR tocan.
 *
 * Sin la firma, cualquiera que conozca la URL podria disparar evaluaciones.
 * No podria forzar un DONE (el veredicto se relee de la API de GitHub, no del
 * cuerpo del webhook), pero si gastar la cuota de la API a voluntad.
 */

/**
 * `X-Hub-Signature-256`: HMAC-SHA256 del cuerpo CRUDO. Del crudo y no del
 * JSON parseado: re-serializar cambia espacios y orden de claves, y la firma
 * deja de coincidir.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  // timingSafeEqual exige largos iguales; y comparar con === filtraria por
  // tiempo cuantos bytes coinciden.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Los PRs que un evento da por evaluables.
 *
 * `check_suite.completed` es el camino de GitHub Actions. `check_run` se
 * acepta tambien porque apps como SonarCloud publican check runs sueltos.
 * Evaluar de mas es inocuo: si el resto de los checks sigue corriendo, la
 * evaluacion responde "esperando".
 */
export function pullRequestsFromCheckSuite(event: string | undefined, payload: unknown): number[] {
  if (event !== 'check_suite' && event !== 'check_run') return [];
  const body = (payload ?? {}) as Record<string, unknown>;
  if (body.action !== 'completed') return [];

  const subject = (body[event] ?? {}) as { pull_requests?: Array<{ number?: unknown }> };
  return (subject.pull_requests ?? [])
    .map((pr) => pr.number)
    .filter((n): n is number => typeof n === 'number');
}
