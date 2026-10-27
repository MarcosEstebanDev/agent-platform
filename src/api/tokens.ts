/**
 * Tokens de inyección, uno por puerto.
 *
 * Se inyecta por token y no por clase concreta a propósito: el controller
 * depende de la interfaz del dominio, no del adapter que la implementa.
 * (Además evita depender de emitDecoratorMetadata, que esbuild no emite.)
 */
export const PRISMA = Symbol('PRISMA');
export const TICKET_REPOSITORY = Symbol('TICKET_REPOSITORY');
export const QUEUE = Symbol('QUEUE');
export const ENQUEUE_TICKET = Symbol('ENQUEUE_TICKET');
export const GITHUB_CONFIG = Symbol('GITHUB_CONFIG');
export const OPEN_PULL_REQUEST = Symbol('OPEN_PULL_REQUEST');
export const EVALUATE_GATES = Symbol('EVALUATE_GATES');
