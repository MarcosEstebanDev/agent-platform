# ADR 0002 — El proveedor de LLM es configuración, no código

**Estado:** Aceptada · 2026-08-22

## Contexto

Este ADR se escribe después de un incidente, no antes.

La plataforma se diseñó originalmente sobre **Managed Agents de Anthropic**. Se
descartó porque requiere una API key con facturación propia, y se eligió
**GitHub Models** por su free tier. Al primer request el endpoint devolvió:

```
410 {"code":"github_models_retirement_brownout"}
```

GitHub Models se había retirado definitivamente el **30/07/2026**, tres semanas
antes. El proveedor elegido estaba muerto antes de escribir la primera línea.

Reemplazarlo por otro proveedor concreto habría dejado el mismo problema
intacto: los free tiers aparecen y desaparecen, y el catálogo de modelos cambia
sin aviso — `llama-3.3-70b-versatile` tampoco existía ya en Groq.

## Decisión

El adapter no se ata a ningún proveedor: implementa el **protocolo** compatible
con OpenAI, y el proveedor concreto vive en el entorno.

```env
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=...
LLM_MODEL=openai/gpt-oss-120b
```

Cambiar de Groq a OpenRouter, Cerebras, el endpoint OpenAI de Gemini o un
Ollama local es editar tres líneas.

Además existe `npm run models`, que lista los modelos que la API key habilita.
Adivinar identificadores de modelo es la forma más rápida de perder media hora
contra un 404.

## Consecuencias

**A favor**

- La muerte de un proveedor cuesta un `.env`, no una refactorización.
- Se puede comparar modelos sobre la misma tarea cambiando una variable.
- El dominio nunca conoció el nombre del proveedor.

**En contra**

- El mínimo común denominador del protocolo OpenAI deja afuera funcionalidades
  propias de cada proveedor (thinking configurable, caché de prompts, agentes
  administrados). Aprovecharlas exige un adapter dedicado — que es exactamente
  lo que el puerto permite hacer sin tocar el resto.
- No todos los modelos soportan tool calling. Un modelo sin esa capacidad
  rompe el loop del agente, y el error no es obvio.

## Notas

`reference/managed-agents/` conserva la implementación sobre Managed Agents.
No es código muerto: es el adapter a resucitar si algún día se abre facturación
de API, porque aporta multiagente, rúbricas y sandbox administrado.
