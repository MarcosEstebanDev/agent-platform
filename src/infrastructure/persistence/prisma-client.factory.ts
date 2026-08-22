import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Prisma 7 no arma la conexión solo: exige un driver adapter explícito.
 * Se encapsula acá para que ningún otro archivo tenga que saberlo.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Falta DATABASE_URL en .env. ¿Levantaste la base con "docker compose up -d"?',
    );
  }
  return url;
}
