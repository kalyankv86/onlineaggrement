import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The API is a separate origin (SDD §2: Next.js and NestJS are distinct layers).
  // Proxying through /api keeps the browser same-origin, so the session cookie is
  // never sent cross-site and CORS stays closed in production.
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${process.env.API_ORIGIN ?? 'http://localhost:3100'}/api/v1/:path*`,
      },
    ];
  },
};

export default config;
