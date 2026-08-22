# ADR 0007 — El veredicto no lo da el agente

**Estado:** Aceptada · 2026-08-22

## Contexto

Al terminar, el agente escribe algo como *"All tests pass successfully"*. Es
tentador usar eso como criterio: si dice que terminó, marcar `DONE`.

Es un error de diseño, por dos razones distintas:

1. **Un modelo puede equivocarse leyendo su propia salida.** Un `exit code 1`
   entre cien líneas de log puede pasar desapercibido, y el reporte final decir
   que todo pasó.
2. **El autoreporte no es verificable.** Aunque acierte el 99% de las veces, no
   hay forma de distinguir el 1% sin comprobarlo por otro lado — y si vas a
   comprobarlo por otro lado, ese otro lado es el veredicto.

Esto se agrava a medida que la plataforma decide cosas más caras: mergear un PR,
desplegar a producción.

## Decisión

**El agente propone; la máquina de estados dispone.**

El agente produce evidencia (archivos, exit codes, salida de tests). El
orquestador la evalúa y decide. La separación se implementa por fases, con la
misma forma:

| Fase | Fuente del veredicto | Confiable |
|---|---|---|
| 1 (hoy) | `outcome` del loop: ¿terminó sin tool calls, o agotó iteraciones? | Parcialmente |
| 3 | Estado de los checks de CI sobre el PR | Sí |
| 4 | Checks + revisión de un agente distinto al que escribió | Sí |

Hoy el veredicto sale de `summary.outcome`, que **no** es el autoreporte en
lenguaje natural: es una propiedad estructural del loop. Es mejor que leer el
texto, y sigue sin ser suficiente — un agente puede terminar prolijamente
habiendo escrito código roto.

La fase 3 cierra la brecha leyendo los checks del PR. En el código eso es una
línea:

```ts
// src/application/run-ticket.use-case.ts
// FASE 1: el veredicto sale del autoreporte del agente.
// FASE 3: sale de los checks del PR, y esta línea cambia.
const finalStatus = summary.outcome === 'completed' ? 'DONE' : 'FAILED';
```

Que sea una línea no es casualidad: es la razón por la que el veredicto está
aislado en el caso de uso en vez de repartido por el loop del agente.

## Consecuencias

**A favor**

- La confiabilidad del veredicto mejora sin tocar el agente.
- Queda explícito, en el código y acá, que la fase 1 tiene una garantía débil.
  Es deuda declarada, no un descuido.
- Habilita el patrón escritor/verificador de la fase 4: el agente que revisa no
  es el que escribió.

**En contra**

- Hasta la fase 3, un `DONE` no significa "el código funciona". Significa "el
  agente terminó su turno sin errores". No hay que apoyarse en ese estado para
  nada consecuente todavía.

## Corolario

Por el mismo motivo, **el despliegue no se le delega al agente**: es una acción
difícil de revertir y pertenece al código determinístico. Ver
[spec 005](../specs/005-despliegue.md).
