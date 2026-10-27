# Spec 004 — Gates de calidad

**Fase:** 3 · **Estado:** Implementada (2026-10-27) · Verificación contra GitHub real pendiente

> El veredicto se decide en el dominio sobre los checks crudos, no en el
> adapter, y SonarCloud entra como un check más. Ver
> [ADR 0013](../adr/0013-el-veredicto-de-los-gates-vive-en-el-dominio.md).

## Objetivo

Que el veredicto de un ticket salga de **señales determinísticas verificables**,
y no del autoreporte del agente.

Esta es la spec que cierra la brecha declarada en
[ADR 0007](../adr/0007-el-veredicto-no-es-del-agente.md).

## El cambio conceptual

```
FASE 1:  agente dice "terminé"  →  DONE
FASE 3:  agente abre PR  →  CI corre  →  orquestador lee los checks  →  DONE
```

El agente sigue corriendo tests dentro del sandbox — eso es **autoverificación**
y sirve para que no entregue basura. Pero no es el gate. El gate es lo que
reporta CI sobre el PR, que el agente no puede escribir.

Dicho de otra forma: el agente puede mentir sobre su propio trabajo, pero no
puede mentir sobre el resultado de un pipeline que no controla.

## Estados

```
PR_OPEN ──▶ CHECKS_RUNNING ──┬──▶ CHECKS_PASSED ──▶ DONE
                             │
                             └──▶ CHANGES_REQUESTED ──▶ ASSIGNED
```

`CHANGES_REQUESTED` vuelve a `ASSIGNED` con el feedback adjunto al `task`. Ese
es el ciclo de corrección: el agente reintenta sabiendo qué falló.

**Límite de reintentos: 3.** Después, `FAILED` con `outcome: 'gates_exhausted'`
y espera intervención humana. Un agente que no puede pasar el gate en tres
intentos no lo va a lograr en el cuarto; lo que hace es quemar tokens.

## Gates

| Gate | Fuente | Bloqueante |
|---|---|---|
| Build | GitHub Actions | Sí |
| Tests | GitHub Actions | Sí |
| Lint | GitHub Actions | Sí |
| SonarCloud quality gate | SonarCloud | Configurable |
| Cobertura no baja | SonarCloud | Configurable |

Los tres primeros son binarios y no se negocian. Los de Sonar se pueden marcar
como advertencia mientras se calibra el proyecto.

### Cómo se entera el orquestador

Dos mecanismos, y hacen falta los dos:

- **Webhook** (`check_suite.completed`) — camino principal, sin latencia.
- **Polling de respaldo** cada 60 s sobre los PRs en `CHECKS_RUNNING`.

El polling no es redundancia decorativa: **los webhooks se pierden**. Si el
servicio estaba caído cuando GitHub reintentó, ese ticket queda esperando para
siempre sin el respaldo.

Timeout de checks: 30 min → `CHANGES_REQUESTED` con motivo `checks_timeout`.

### Feedback al agente

Al volver a `ASSIGNED`, el `task` se enriquece con lo que falló:

```
<task original>

---
Intento anterior (PR #42) falló:
  ✗ test — 2 tests fallando en src/auth/login.test.ts
      Expected 401, received 500
  ✓ build
  ✓ lint

Corregí la causa. No modifiques los tests para hacerlos pasar.
```

Esa última línea importa: sin ella, un agente presionado por un gate tiende a
"arreglar" el test en lugar del código.

### Puerto nuevo

```ts
export interface QualityGatePort {
  fetchStatus(repo: string, prNumber: number): Promise<{
    state: 'pending' | 'passed' | 'failed';
    checks: Array<{ name: string; conclusion: string; summary?: string }>;
  }>;
}
```

Adapters: `GitHubChecksAdapter`, `SonarCloudAdapter`. SonarCloud se consulta
host-side, con credenciales del orquestador — **nunca** desde el sandbox.

## El cambio en el código

En `run-ticket.use-case.ts` desaparece esto:

```ts
const finalStatus = summary.outcome === 'completed' ? 'DONE' : 'FAILED';
```

y el ticket pasa a `PR_OPEN`. La decisión se muda a un caso de uso nuevo,
`EvaluateGatesUseCase`, disparado por el webhook o por el poller.

## Modos de falla

| Falla | Comportamiento |
|---|---|
| Webhook perdido | El poller lo detecta en ≤ 60 s |
| CI se cuelga | Timeout a 30 min → `CHANGES_REQUESTED` |
| SonarCloud no responde | Si no es bloqueante, se ignora con warning; si lo es, reintento con backoff |
| Tres ciclos sin pasar | `FAILED` con `gates_exhausted`, requiere humano |

## Criterio de aceptación

Verificado contra dobles (`FakeQualityGate`) y, el webhook, con firmas HMAC
reales sobre HTTP. La corrida contra un PR real con GitHub Actions está
pendiente: ver "Verificación real" en el README.

- [x] Un PR con tests en verde lleva el ticket a `DONE` sin intervención.
- [x] Un PR con tests en rojo lo lleva a `CHANGES_REQUESTED`, no a `DONE`.
      → y de ahí a `ASSIGNED`, reencolado: el agente reintenta solo.
- [x] El feedback de los checks fallidos llega al `task` del reintento.
      → se guarda en `gate_feedback` y se compone con el task original
      (`composeTask`) en vez de reescribirlo, para no apilar intentos.
- [x] Ignorar el webhook a propósito: el poller cierra el ticket igual.
- [x] Tres ciclos fallidos terminan en `FAILED`, no en un bucle infinito.
      → `status_reason = 'gates_exhausted'`. Reencolar a mano desde FAILED
      devuelve los tres intentos.
- [x] Ningún `DONE` se emite sin al menos un check verde asociado.
      → regla de `evaluateChecks`, y además la lista blanca: el único camino a
      DONE es `CHECKS_PASSED → DONE`.

Desvíos:

- El estado se guarda en la columna `status_reason` del ticket, no como
  `outcome` de la corrida: `gates_exhausted` le pasa al ticket, no a una
  corrida (la última terminó bien; lo que falló es CI).
- El webhook acepta `check_suite.completed` **y** `check_run.completed`:
  SonarCloud publica check runs sueltos. Evaluar de más es inocuo.
