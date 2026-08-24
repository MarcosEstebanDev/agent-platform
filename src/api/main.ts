import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const port = Number(process.env.PORT ?? 3000);

const app = await NestFactory.create(AppModule, { logger: ['log', 'error', 'warn'] });
app.enableShutdownHooks();
await app.listen(port);

console.log(`\n  API escuchando en http://localhost:${port}`);
console.log('  POST   /tickets                         { "title": "...", "task": "..." }');
console.log('  GET    /tickets                         ?status=BACKLOG');
console.log('  GET    /tickets/:id');
console.log('  POST   /tickets/:id/run                 202: encola, no ejecuta');
console.log('  GET    /tickets/:id/runs                estado de cada corrida');
console.log('  GET    /tickets/:id/runs/:runId/events  traza (?after=&limit=)');
console.log('\n  El agente corre en el worker: npm run worker\n');
