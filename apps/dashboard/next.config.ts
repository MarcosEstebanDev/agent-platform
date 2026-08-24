import type { NextConfig } from 'next';

/**
 * El navegador nunca habla con la API directo: pega contra /api/* del propio
 * dashboard y Next lo reescribe.
 *
 * Asi no hay CORS que configurar, la API no necesita saber que existe un
 * frontend, y el dia que esto se despliegue detras de un proxy la unica
 * variable que cambia es API_URL.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000';

const config: NextConfig = {
  // Hay dos package-lock.json (la raiz y este). Sin esto Next elige la raiz
  // como root del trace y avisa en cada build.
  outputFileTracingRoot: import.meta.dirname,

  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
};

export default config;
