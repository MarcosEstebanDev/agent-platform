# Spec 005 — Despliegue

**Fase:** 6 · **Estado:** Especificada

## Objetivo

Llevar a producción el código que pasó todos los gates, **sin darle al agente la
capacidad de desplegar**.

## Principio

> El agente propone, la máquina de estados dispone, y el despliegue lo dispara
> el orquestador.

Un despliegue es difícil de revertir y afecta a usuarios reales. Pertenece al
código determinístico, no a un worker probabilístico. Esto no es desconfianza en
el modelo: es que **el modelo no tiene la información para decidir** — no sabe
si hay un incidente activo, si es viernes a las 18 h, ni si otro despliegue está
en curso.

## Estados

```
CHECKS_PASSED ──▶ AWAITING_APPROVAL ──▶ MERGED ──▶ DEPLOYING ──┬──▶ DEPLOYED
                          │                                    │
                          └──▶ REJECTED                        └──▶ ROLLED_BACK
```

`AWAITING_APPROVAL` es un estado real, no un trámite: es donde un humano decide.
Se puede autoaprobar por política (ver abajo), pero el estado existe siempre —
así la traza registra quién aprobó qué y cuándo.

## Política de aprobación

Configurable por entorno, y el default es el conservador:

| Entorno | Aprobación | Justificación |
|---|---|---|
| `dev` | Automática si todos los gates pasan | Barato de revertir |
| `staging` | Automática | Ídem |
| `production` | **Humana, siempre** | No es barato de revertir |

## Si el agente pide desplegar

Se puede permitir que el agente *solicite* un despliegue, nunca que lo ejecute.
Dos mecanismos, según cómo esté expuesto:

**a) Como custom tool (preferido).** El orquestador es el ejecutor: el agente
emite la invocación, la sesión queda en pausa, y el orquestador decide. El gate
es gratis — el agente nunca tuvo acceso al mecanismo de deploy.

**b) Vía MCP o bash.** Requiere una política explícita de tipo `always_ask`: la
sesión se bloquea hasta que un humano confirme o rechace, con un motivo que el
agente lee y usa para corregir el rumbo.

La opción (a) es mejor porque la capacidad **no existe** del lado del agente. En
(b) existe y está custodiada — y toda custodia se puede configurar mal.

## Flujo

```
1. Gates en verde                    → CHECKS_PASSED
2. Evaluar política de aprobación    → AWAITING_APPROVAL
3. Aprobación (humana o automática)  → registrada en la traza con actor y timestamp
4. Merge del PR                      → MERGED
5. Disparar el workflow de deploy    → DEPLOYING
6. Esperar el resultado              → DEPLOYED | ROLLED_BACK
```

El paso 5 dispara un workflow existente del repositorio. **La plataforma no
inventa un mecanismo de despliegue propio**: usa el que el equipo ya tiene y
ya sabe operar.

### Puerto nuevo

```ts
export interface DeploymentPort {
  trigger(input: { repo: string; ref: string; environment: string })
    : Promise<{ runId: string }>;
  getStatus(runId: string)
    : Promise<'queued' | 'running' | 'success' | 'failure'>;
  rollback(input: { repo: string; environment: string })
    : Promise<void>;
}
```

## Rollback

Un deploy fallido dispara rollback automático al release anterior y deja el
ticket en `ROLLED_BACK`. **No hay reintento automático**: si un despliegue
falló, el sistema no sabe por qué, y reintentar a ciegas puede empeorarlo.

## Auditoría

Cada despliegue registra:

| Campo | Por qué |
|---|---|
| Ticket, corrida y PR de origen | Trazabilidad de qué código salió |
| Quién aprobó y cuándo | Responsabilidad |
| Commit desplegado | Reproducibilidad |
| Resultado y duración | Métricas |
| Si hubo rollback y por qué | Postmortems |

Con eso, "¿por qué está esto en producción?" se responde con una consulta SQL
que llega hasta el comando exacto que ejecutó el agente.

## Modos de falla

| Falla | Comportamiento |
|---|---|
| Merge con conflictos | `CHANGES_REQUESTED`, el agente rebasa |
| El workflow no arranca | `FAILED` con el error; **no** se reintenta solo |
| Deploy falla | Rollback automático → `ROLLED_BACK` |
| Rollback falla | Alerta y `FAILED`. Intervención humana obligatoria. |
| Aprobación sin responder en 24 h | Expira → `REJECTED`. Un ticket no espera para siempre. |

## Criterio de aceptación

- [ ] Ningún despliegue a producción ocurre sin una aprobación registrada.
- [ ] El agente no tiene, en ningún momento, credenciales de despliegue.
- [ ] Un deploy fallido dispara rollback automático.
- [ ] Un rollback fallido genera alerta y **no** se reintenta solo.
- [ ] Desde un despliegue se puede llegar por consulta al comando que ejecutó
      el agente.
- [ ] Una aprobación sin respuesta expira; no queda colgada.
