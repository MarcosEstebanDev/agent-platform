# ADR 0006 — Traza append-only, best-effort

**Estado:** Aceptada · 2026-08-22

## Contexto

Cuando un agente entrega un resultado incorrecto, la pregunta no es *qué dijo*
sino *qué hizo*: qué comandos ejecutó, con qué argumentos, qué devolvió cada
uno. Sin eso, depurar es interrogar a un modelo sobre su propio pasado — y un
modelo no es una fuente confiable sobre sí mismo.

El resumen final del agente tampoco sirve como evidencia: es texto que él
escribe, y puede describir un éxito que no ocurrió.

## Decisión

Cada `AgentEvent` que emite el loop se persiste en `agent_events` con un número
de secuencia por corrida:

```sql
seq | type        | payload
----+-------------+----------------------------------------
  0 | tool_call   | {"name":"write_file","args":{...}}
  1 | tool_result | {"ok":true,"preview":"Escrito: ..."}
  4 | tool_call   | {"name":"bash","args":{"command":"node --test"}}
  5 | tool_result | {"ok":true,"preview":"exit code: 0\nTAP..."}
  7 | done        | {"reason":"completed"}
```

Tres propiedades:

- **Append-only.** Nunca se actualiza ni se borra una fila. `UNIQUE (run_id, seq)`
  impide duplicados y huecos silenciosos.
- **`seq`, no timestamp.** Varios eventos pueden caer en el mismo milisegundo;
  el orden causal necesita un contador.
- **Best-effort.** Si el `INSERT` falla, se traga la excepción y la corrida
  sigue.

Ese último punto es el que hay que justificar.

## Por qué best-effort

El log es un observador, no un participante. Si la base parpadea a mitad de
corrida, hay dos opciones:

1. Abortar el trabajo del agente porque no se pudo registrar un evento.
2. Perder un evento y conservar el trabajo.

La segunda es correcta. El agente ya escribió archivos y corrió tests; tirar eso
porque falló una escritura auxiliar cambia un problema de observabilidad por uno
de negocio. El veredicto del ticket no depende del log.

**Esto no aplica a la transición de estado.** Esa sí es participante: si falla,
el ticket queda inconsistente. Por eso la transición no se traga errores.

## Consecuencias

**A favor**

- Auditoría completa y consultable con SQL plano.
- El log no puede provocar una falla que no habría ocurrido sin él.
- Base para métricas de costo y para reproducir corridas.

**En contra**

- La traza puede tener huecos. Un `seq` faltante significa "falló el registro",
  no "no ocurrió" — hay que leerla con esa advertencia.
- `payload` no tiene límite de tamaño: un `tool_call` que escribe un archivo
  grande guarda el archivo entero en una fila. **Deuda conocida:** truncar el
  payload y dejar un puntero al contenido completo.
