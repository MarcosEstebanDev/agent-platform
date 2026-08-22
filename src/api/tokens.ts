/**
 * Tokens de inyección, uno por puerto.
 *
 * Se inyecta por token y no por clase concreta a propósito: el controller
 * depende de la interfaz del dominio, no del adapter que la implementa.
 * (Además evita depender de emitDecoratorMetadata, que esbuild no emite.)
 */
export const PRISMA = Symbol('PRISMA');
export const LLM = Symbol('LLM');
export const SANDBOX_FACTORY = Symbol('SANDBOX_FACTORY');
export const TICKET_REPOSITORY = Symbol('TICKET_REPOSITORY');
export const RUN_TICKET = Symbol('RUN_TICKET');
