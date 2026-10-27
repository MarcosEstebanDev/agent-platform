import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const port = Number(process.env.PORT ?? 3000);

// rawBody: la firma del webhook de GitHub se calcula sobre el cuerpo CRUDO.
const app = await NestFactory.create(AppModule, {
  logger: ['log', 'error', 'warn'],
  rawBody: true,
});
app.enableShutdownHooks();
await app.listen(port);

console.log(`\n  API escuchando en http://localhost:${port}`);
console.log('  POST   /tickets                         { "title": "...", "task": "..." }');
console.log('  GET    /tickets                         ?status=BACKLOG');
console.log('  GET    /tickets/:id');
console.log('  POST   /tickets/:id/run                 202: encola, no ejecuta');
console.log('  GET    /tickets/:id/runs                estado de cada corrida');
console.log('  GET    /tickets/:id/runs/:runId/events  traza (?after=&limit=)');
console.log('  POST   /tickets/:id/pull-request        reintenta el PR sin reejecutar al agente');
console.log('  POST   /tickets/:id/gates               evalua los checks del PR ya');
console.log('  POST   /webhooks/github                 check_suite / check_run (firma HMAC)');
console.log('\n  El agente corre en el worker: npm run worker\n');
