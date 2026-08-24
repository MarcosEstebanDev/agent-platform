import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'agent-platform',
  description: 'Orquestacion de workflows distribuidos con workers LLM',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <header className="topbar">
          <a href="/" className="brand">
            agent<span>-platform</span>
          </a>
          <span className="tagline">workers LLM sobre sandboxes efimeros</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
