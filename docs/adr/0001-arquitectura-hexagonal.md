# ADR 0001 — Arquitectura hexagonal con dominio puro

**Estado:** Aceptada · 2026-08-22

## Contexto

La plataforma coordina tres cosas volátiles: un modelo de lenguaje, un entorno
de ejecución aislado y una base de datos. Las tres cambian por razones ajenas al
problema que resolvemos — un proveedor se retira, Docker se reemplaza por otra
cosa, Prisma rompe su API entre versiones mayores.

Lo que **no** cambia es la lógica de coordinación: qué transiciones son válidas,
cuándo se toma un ticket, qué se registra, quién decide el veredicto. Esa lógica
es el activo real del proyecto.

Además, esa misma lógica es la que puede corromper estado. Si sólo se puede
probar levantando Postgres, Docker y llamando a un modelo pago, en la práctica
no se prueba.

## Decisión

Tres capas, con las dependencias apuntando siempre hacia adentro:

```
api/  ──▶  application/  ──▶  domain/  ◀──  infrastructure/
```

- **`domain/`** — entidades, máquina de estados y **puertos** (interfaces).
  Prohibido importar Nest, Prisma, el SDK del proveedor o `node:child_process`.
- **`application/`** — casos de uso. Dependen sólo de puertos.
- **`infrastructure/`** — adapters que implementan los puertos.
- **`api/`** — NestJS como adapter de entrada, y composition root.

Los puertos se declaran del lado del dominio, no del adapter. El dominio dice
qué necesita; la infraestructura se adapta.

## Consecuencias

**A favor**

- La lógica de orquestación se prueba con dobles: 20 tests en 735 ms, sin base,
  sin Docker y sin LLM.
- Reemplazar un adapter no toca el dominio. Ya se cobró dos veces
  (ver [0002](0002-proveedor-de-llm-agnostico.md)).
- El composition root único hace explícito qué implementación concreta se usa.

**En contra**

- Más archivos e indirección para el mismo comportamiento.
- Hay que resistir la tentación de filtrar tipos de infraestructura al dominio.
  Un `import type { PrismaClient }` en `domain/` es el primer síntoma.

**Cómo se verifica que no se degrade**

`src/domain/` no debe importar nada fuera de `src/domain/`. Hoy se revisa a
mano; a futuro conviene un lint rule que lo haga fallar en CI.
