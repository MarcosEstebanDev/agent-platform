# Documentación

Dos tipos de documento, con propósitos distintos:

- **ADR** (`adr/`) — decisiones ya tomadas, con su contexto y sus consecuencias.
  Son inmutables: si una decisión cambia, se escribe un ADR nuevo que supersede
  al anterior. Responden *por qué esto es así*.
- **Spec** (`specs/`) — el comportamiento que la plataforma debe tener, esté
  implementado o no. Responden *qué tiene que pasar*.

Una spec puede describir algo que todavía no existe; un ADR nunca.

## Decisiones (ADR)

| # | Decisión | Estado |
|---|---|---|
| [0001](adr/0001-arquitectura-hexagonal.md) | Arquitectura hexagonal con dominio puro | Aceptada |
| [0002](adr/0002-proveedor-de-llm-agnostico.md) | El proveedor de LLM es configuración, no código | Aceptada |
| [0003](adr/0003-sandbox-como-unica-frontera.md) | El sandbox es la única frontera de ejecución | Aceptada |
| [0004](adr/0004-maquina-de-estados-lista-blanca.md) | Transiciones por lista blanca | Aceptada |
| [0005](adr/0005-claim-por-compare-and-set.md) | Tomar un ticket es un compare-and-set | Aceptada |
| [0006](adr/0006-traza-append-only.md) | Traza append-only, best-effort | Aceptada |
| [0007](adr/0007-el-veredicto-no-es-del-agente.md) | El veredicto no lo da el agente | Aceptada |

## Comportamiento (Spec)

| # | Spec | Fase | Estado |
|---|---|---|---|
| [001](specs/001-ciclo-de-vida-del-ticket.md) | Ciclo de vida del ticket | 1 | Implementada |
| [002](specs/002-ejecucion-asincrona.md) | Ejecución asíncrona y recuperación | 1b | Especificada |
| [003](specs/003-pull-requests.md) | Ramas y pull requests | 2 | Especificada |
| [004](specs/004-gates-de-calidad.md) | Gates de calidad | 3 | Especificada |
| [005](specs/005-despliegue.md) | Despliegue | 6 | Especificada |

## Cómo leer esto

Si venís de cero: **spec 001** para entender el modelo, después **ADR 0004** y
**0005** para entender por qué el estado se maneja así.

Si vas a implementar la fase siguiente: la spec correspondiente tiene el
criterio de aceptación al final. Eso es lo que tiene que pasar para darla por
cerrada.
