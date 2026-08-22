/** Verifica que el cliente de Prisma conecte y que el repo funcione. */
import {
  createPrismaClient,
  requireDatabaseUrl,
} from './infrastructure/persistence/prisma-client.factory.js';
import { PrismaTicketRepository } from './infrastructure/persistence/prisma-ticket.repository.js';

const prisma = createPrismaClient(requireDatabaseUrl());
const repo = new PrismaTicketRepository(prisma);

try {
  const ticket = await repo.create({ title: 'smoke', task: 'no-op' });
  console.log(`✓ create      → ${ticket.id} (${ticket.status})`);

  const claimed = await repo.transition(ticket.id, 'BACKLOG', 'ASSIGNED');
  console.log(`✓ transition  → ${claimed?.status}`);

  const stolen = await repo.transition(ticket.id, 'BACKLOG', 'ASSIGNED');
  console.log(`✓ compare-and-set rechaza el estado viejo → ${stolen === null ? 'null (correcto)' : 'PROBLEMA'}`);

  const run = await repo.startRun({ ticketId: ticket.id, model: 'test' });
  await repo.appendEvent(run.id, 0, { type: 'text', text: 'hola' });
  await repo.finishRun(run.id, {
    outcome: 'completed',
    iterations: 1,
    inputTokens: 10,
    outputTokens: 5,
  });
  console.log(`✓ run + evento + cierre → ${run.id}`);

  await prisma.ticket.delete({ where: { id: ticket.id } });
  console.log('✓ cleanup (cascade a runs y eventos)');
  console.log('\n✓ Persistencia operativa.');
} finally {
  await prisma.$disconnect();
}
