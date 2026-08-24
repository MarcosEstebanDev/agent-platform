# ADR 0011 — El container lleva el id de su corrida, y la base decide quién es basura

**Estado:** Aceptada · 2026-08-24 · Completa [ADR 0008](0008-liveness-por-latido.md)

## Contexto

El reaper del [ADR 0008](0008-liveness-por-latido.md) resolvió la mitad del
problema de un worker muerto: la corrida deja de figurar como viva. La otra
mitad quedó abierta y registrada como deuda — cuando el worker muere,
`sandbox.stop()` nunca corre, y **el container sigue vivo**. Cada uno se lleva
hasta 2 GB de RAM reservada. La única limpieza era `docker rm -f agent-sbx-*` a
mano.

Un barrido automático necesita responder una pregunta que parece simple: dado un
container, ¿alguien lo está usando?

A Docker no se le puede preguntar. El proceso principal del sandbox es
`sleep infinity`, que está igual de vivo mientras un agente trabaja que tres
días después de que su worker murió. El estado del container no distingue los
dos casos porque, desde Docker, **son el mismo caso**.

Filtrar por nombre (`agent-sbx-*`) alcanza para encontrar los containers de la
plataforma, pero no para saber cuáles siguen trabajando. Y un barrido que se
equivoque destruye el sandbox de una corrida en curso.

## Decisión

**El container lleva el id de su corrida como label**, y quién está vivo lo
decide la base.

```
docker run --label agent-platform.run=<runId> ...
```

El barrido tiene tres pasos:

1. Listar containers con ese label (nunca toca nada ajeno: otro Docker en la
   misma máquina es invisible).
2. Preguntarle a la base cuáles de esos `runId` siguen abiertos.
3. Destruir los que no.

La política vive en un caso de uso (`SweepOrphanSandboxesUseCase`) y no en el
adapter. El adapter sólo informa qué existe; no opina sobre qué sobra.

**Sólo se etiqueta lo que la base puede juzgar.** Un sandbox suelto
(`npm run run`) no tiene fila en `agent_runs`, así que nadie puede decidir si
sigue trabajando — y lo que no se puede juzgar, no se barre. Por eso, sin
`runId`, el container no lleva label y el barrido no lo ve.

Una corrida que la base no conoce sí es huérfana: la fila pudo borrarse con su
ticket (`onDelete: Cascade`) y el container quedó igual.

### Gracia de 60 segundos

Un container recién creado nunca es candidato. Cubre una carrera concreta: la
corrida se marca terminada **antes** de que `stop()` alcance a destruir el
container. Sin gracia, un barrido que caiga en esa ventana destruiría un sandbox
del que su propio dueño se está despidiendo.

### Dos barridos que no se conocen

El reaper y el janitor corren en el mismo intervalo y **no se llaman entre sí**.
Se coordinan a través de la base:

```
worker muere
   │
   ├─ reaper (≤ 2 min):  agent_runs.finished_at = now(), outcome = 'abandoned'
   │                      el ticket vuelve a FAILED
   │
   └─ janitor (barrido siguiente): ve un container cuya corrida ya cerró
                                    docker rm -f
```

Podrían ser un solo barrido. Son dos porque fallan distinto: el reaper necesita
la base y el janitor necesita el daemon de Docker. Con Docker apagado el janitor
no encuentra nada que limpiar —que es la respuesta correcta— y el reaper sigue
cerrando corridas sin enterarse.

## Consecuencias

**A favor**

- La memoria se libera sola. La deuda #1 de la [spec 002](../specs/002-ejecucion-asincrona.md)
  deja de existir.
- El barrido no puede tocar containers ajenos ni sandboxes sueltos.
- Correr varios workers es inofensivo: dos janitors que decidan lo mismo
  destruyen lo mismo, y el segundo `docker rm` sobre algo que ya no existe no es
  un error, es el resultado buscado.
- La misma identidad sirve después para atribuir un container a una corrida
  cuando haga falta depurar.

**En contra**

- El barrido cuesta un `docker ps` y un `docker inspect` cada 30 s aunque no
  haya nada que limpiar. Se mitiga: sin containers gestionados no se consulta la
  base.
- Un container cuya fecha de creación no se puede parsear se trata como
  infinitamente viejo. Es deliberado — que un dato ilegible lo dejara "recién
  nacido" para siempre lo volvería inmortal, que es el bug que esto viene a
  arreglar— pero significa que un `inspect` raro puede adelantar una
  destrucción.
- La limpieza depende de que haya al menos un worker vivo. Si mueren todos, los
  containers quedan hasta que alguno vuelva.

## Notas

`--rm` ya estaba en el `docker run` y no alcanza: sólo actúa cuando el proceso
principal termina, y `sleep infinity` no termina nunca. Es un buen ejemplo de
mecanismo que parece cubrir el caso y no lo cubre.
