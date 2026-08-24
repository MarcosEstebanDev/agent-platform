# ADR 0010 — Git corre fuera del sandbox

**Estado:** Aceptada · 2026-08-24 · Refina [ADR 0003](0003-sandbox-como-unica-frontera.md)

## Contexto

`sandbox.stop()` destruye el container, y con él todo lo que el agente
escribió. Para la fase 1 daba igual: sólo se verificaba que el loop cerrara.
Para abrir un Pull Request no da igual — no se puede proponer código que ya no
existe. Sacar el trabajo antes de apagar es prerequisito, no mejora.

La [spec 003](../specs/003-pull-requests.md) proponía resolverlo dentro del
container:

```bash
git add -A && git commit -m "..."
git format-patch origin/main --stdout
```

Al implementarlo aparecieron dos cosas. La primera, menor: la imagen del
sandbox (`node:22-bookworm-slim`) **no trae git**. Se arregla con una imagen
más pesada o una propia.

La segunda no se arregla comprando imagen. La misma spec exige, dos secciones
más abajo, que el PAT del repositorio **no entre al container**, y reconoce que
con Docker local eso obliga a construir un proxy que inyecte el token después
de que la request salga del sandbox. Es decir: la spec pedía que git corriera
adentro y que las credenciales de git se quedaran afuera. Se puede hacer, pero
cuesta una pieza de infraestructura entera cuyo único propósito es sostener esa
contradicción.

Y la contradicción importa más de lo que parece, porque el contenido del
sandbox es **código escrito por un modelo a partir de texto que no controlamos**.
Un PAT con `Contents: write` ahí adentro es exactamente lo que una inyección de
prompt querría encontrar.

## Decisión

**Git no entra al sandbox.** El sandbox hace una sola cosa: ejecutar código no
confiable. Clonar, commitear, pushear y abrir PRs son responsabilidad del
orquestador, del lado de afuera.

El puerto suma una operación para cruzar la frontera en el sentido que faltaba:

```ts
exportFiles(options?: ExportOptions): Promise<WorkspaceExport>;
```

El adapter de Docker la implementa haciendo que el container emita una línea
por archivo con la forma `<ruta-b64> <bytes> <estado> [contenido-b64]`.

Tres decisiones dentro de esa línea:

- **Base64 para la ruta y para el contenido.** No es paranoia: una ruta con
  espacios, comillas o un salto de línea rompe cualquier parseo por delimitador,
  y un archivo que contenga comillas rompe el JSON armado a mano en bash. En
  base64 no existen caracteres conflictivos, así que el escapeo deja de ser una
  categoría de bug en vez de un bug que se arregla.
- **Los techos se aplican dentro del shell.** Filtrar del lado de Node llegaría
  tarde: los cientos de megas ya habrían viajado por el pipe y reventado el
  `maxBuffer` de `execFile` antes de que nadie pudiera descartarlos.
- **Lo omitido se informa, no se descarta en silencio.** Cada archivo que no
  entró queda listado con su motivo (`too_large`, `binary`, `budget`). Un PR
  incompleto sin explicación es peor que uno que dice qué falta.

El resultado se persiste en `run_artifacts`, una tabla aparte y no columnas en
`agent_runs`: el tablero lista corridas constantemente, y arrastrar el contenido
de los archivos en cada refresco encarece la lectura más frecuente del sistema.

## Consecuencias

**A favor**

- Ninguna credencial cruza la frontera del sandbox. No hay proxy que construir
  porque no hay token adentro que proteger.
- El [ADR 0003](0003-sandbox-como-unica-frontera.md) queda intacto en vez de
  parcialmente contradicho.
- La imagen del sandbox sigue siendo chica (~230 MB) y sin red por default.
- El trabajo sobrevive a la corrida: si el push o el PR fallan, se reintenta sin
  volver a gastar tokens.

**En contra**

- El agente **no puede usar git como herramienta**. No puede mirar el historial,
  ni hacer `git diff` para revisar lo suyo. Si algún día hace falta, se resuelve
  montando un repo de sólo lectura, no dándole credenciales.
- `SandboxPort` crece: `exportFiles` es la única operación que existe por cómo
  se destruye el entorno y no por lo que el agente necesita.
- La extracción tiene techos, así que el artefacto puede estar incompleto. Es
  visible (`truncated`), pero es una diferencia real contra "el container tenía
  todo".
- Los binarios no viajan. Se detectan por byte nulo y se registran como
  omitidos, porque guardarlos como texto los corrompería en silencio.

## Notas

El rescate **no puede tumbar la corrida**: si el agente resolvió la tarea, que
falle sacar los archivos no invalida lo que hizo. Se registra el error en la
traza y la corrida cierra con su veredicto.

Eso cambia de peso cuando la fase 2 abra PRs: ahí sin artefacto no hay PR
posible. Pero la decisión de qué hacer con eso pertenece al flujo del PR, no al
rescate — que sigue siendo el que informa, no el que juzga
([ADR 0007](0007-el-veredicto-no-es-del-agente.md)).
