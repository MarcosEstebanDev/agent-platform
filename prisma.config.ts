import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Desde Prisma 7 la URL de conexión se configura acá, no en el schema.
 * `env()` explota si la variable no está definida, en vez de intentar
 * conectarse a undefined.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
