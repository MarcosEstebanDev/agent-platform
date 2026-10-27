# ADR 0013 — El veredicto de los gates vive en el dominio

**Estado:** Aceptada · 2026-10-27 · Cierra la brecha declarada en [ADR 0007](0007-el-veredicto-no-es-del-agente.md)

## Contexto

La [spec 004](../specs/004-gates-de-calidad.md) definía el puerto así:

```ts
fetchStatus(repo, prNumber): Promise<{
  state: 'pending' | 'passed' | 'failed';
  checks: [...];
}>;
```

con dos adapters, `GitHubChecksAdapter` y `SonarCloudAdapter`.

Si el adapter devuelve `state`, cada adapter decide qué es "verde". Y la regla
tiene matices que no son de ningún proveedor sino de la plataforma: ¿un PR sin
checks pasa? ¿Un check `skipped` cuenta como verde? ¿Se espera a que terminen
todos si uno ya dio rojo? Repartida entre adapters, la definición de DONE
dependería de contra qué CI se corre.

## Decisión

**El puerto devuelve los checks crudos; la regla vive en el dominio.**

```ts
interface QualityGatePort {
  fetchChecks(repo, prNumber): Promise<CheckRun[]>;
}

// src/domain/quality-gates.ts — puro, sin I/O
evaluateChecks(checks, { nonBlocking }): { state, failed, warnings }
```

La regla:

| Situación | Veredicto |
|---|---|
| Algún check bloqueante en rojo (`failure`, `cancelled`, `timed_out`, `action_required`, `stale`) | `failed`, aunque otros sigan corriendo |
| Alguno corriendo, ninguno en rojo | `pending` |
| Todos terminados y **al menos uno** `success` | `passed` |
| Cero checks, o solo `skipped` / `neutral` | `pending` |
| Un no bloqueante en rojo | no frena; queda como advertencia |

La cuarta fila es el criterio "ningún DONE sin al menos un check verde": sin
ella, un repo sin CI pasaría por vacío (cero checks, cero rojos). Con ella
espera, vence el timeout de 30 min y cuenta como rechazo.

**SonarCloud no tiene adapter propio.** Publica su quality gate como un check
run sobre el commit, así que llega por `fetchChecks` igual que GitHub Actions.
"Configurable" (spec 004) se resuelve con `GATES_NON_BLOCKING`: una lista de
nombres de checks que avisan pero no bloquean.

Y como corolario, la máquina de estados ya no tiene `IN_PROGRESS → DONE`. El
único camino a DONE es `CHECKS_PASSED → DONE`, y a CHECKS_PASSED sólo llega
`EvaluateGatesUseCase`. Que el agente no pueda dar el veredicto deja de ser una
convención del código y pasa a ser una propiedad de la lista blanca, que un
test verifica.

## Consecuencias

**A favor**

- La definición de DONE está en un solo lugar, es pura y se prueba en
  milisegundos.
- Un proveedor de CI nuevo es un adapter que traduce sus checks a `CheckRun`,
  sin opinión sobre qué significa "pasar".
- No hay que mantener credenciales de SonarCloud en el orquestador.

**En contra**

- Sin DONE local: el worker exige `GITHUB_TOKEN` y un repo. Correr al agente
  "a ver qué hace" sin GitHub queda para `npm run run`, que no persiste nada.
- Las métricas de Sonar que no se publican como check (cobertura histórica,
  por ejemplo) no se ven. Si hacen falta, va un adapter de Sonar que las
  traduzca a `CheckRun`, no una regla nueva.
- Un repo sin CI nunca llega a DONE: agota los tres intentos por timeout. Es
  deliberado (sin evidencia no hay veredicto), pero cuesta tres corridas
  descubrirlo. `checkAccess` no lo detecta.
