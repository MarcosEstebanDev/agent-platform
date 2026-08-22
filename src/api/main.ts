import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const port = Number(process.env.PORT ?? 3000);

const app = await NestFactory.create(AppModule, { logger: ['log', 'error', 'warn'] });
app.enableShutdownHooks();
await app.listen(port);

console.log(`\n  API escuchando en http://localhost:${port}`);
console.log('  POST   /tickets           { "title": "...", "task": "..." }');
console.log('  GET    /tickets           ?status=BACKLOG');
console.log('  GET    /tickets/:id');
console.log('  POST   /tickets/:id/run   ← ejecuta el agente (síncrono)\n');
