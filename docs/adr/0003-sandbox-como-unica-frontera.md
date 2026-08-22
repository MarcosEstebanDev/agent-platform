# ADR 0003 — El sandbox es la única frontera de ejecución

**Estado:** Aceptada · 2026-08-22

## Contexto

El agente recibe una tarea en lenguaje natural y tiene una herramienta `bash`.
Los comandos que ejecuta los **decide un modelo**, no un programador. Eso los
convierte en entrada no confiable, por dos vías distintas:

1. **Error honesto** — el modelo se equivoca y ejecuta algo destructivo.
2. **Inyección de prompt** — hoy los tickets los escribe una persona de
   confianza. En la fase 6 vienen de Jira, y cualquiera que pueda crear un
   ticket puede escribir instrucciones para el agente.

La segunda es la que importa a futuro, y no se resuelve con prompts: se resuelve
acotando qué puede hacer el proceso.

## Decisión

**Todo lo que el agente ejecuta pasa por `SandboxPort`. Nada corre en la máquina
anfitriona.**

La implementación (`DockerSandbox`) sostiene esa frontera con defaults
restrictivos:

| Control | Default | Por qué |
|---|---|---|
| Red | `--network none` | Sin egress no hay exfiltración ni descarga de payloads |
| Memoria | `2g` | Acota el daño de un proceso desbocado |
| CPU | `2` | Ídem |
| Timeout por comando | 120 s | Un comando colgado no bloquea la corrida |
| Vida del container | una corrida | Ningún ticket ve los archivos de otro |

Del lado del anfitrión, los comandos se invocan con `execFile` y argumentos en
array — **nunca** interpolando strings en un shell local. El comando del modelo
es un argumento que viaja a `docker exec`; nunca lo interpreta la shell de
Windows.

## Consecuencias

**A favor**

- El radio de daño de una inyección de prompt está acotado por construcción, no
  por la calidad del system prompt.
- Cada corrida arranca de cero: los resultados son reproducibles.
- La frontera es un solo puerto, así que auditarla es leer un archivo.

**En contra**

- Sin red, el agente no puede `npm install`. Para tareas que lo necesiten hay
  que poner `SANDBOX_NETWORK=bridge`, **y eso levanta el techo de seguridad**.
  Es una decisión consciente por entorno, no un default.
- Un container por corrida cuesta ~1 s de arranque.
- Al destruirse el container se pierden los archivos. La fase 2 necesita
  extraer el diff antes del `stop()` — ver
  [spec 003](../specs/003-pull-requests.md).

## Alternativas descartadas

- **Ejecutar en el anfitrión con una lista blanca de comandos.** Una lista negra
  o blanca de comandos se elude con `bash -c`, sustitución de variables o
  encadenamiento. El aislamiento a nivel de proceso es una garantía; el parseo
  de comandos es una carrera armamentista.
- **Sandbox compartido entre corridas.** Más rápido, pero un ticket podría leer
  o pisar el trabajo de otro, y los resultados dejarían de ser reproducibles.
