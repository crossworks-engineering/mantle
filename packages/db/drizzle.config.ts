import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    'DATABASE_URL must be set (run `pnpm infra:up` first, then copy from .env.example)',
  );

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  // Drizzle only manages public.*; auth.users is hand-managed (see schema/auth-users.ts).
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
});
