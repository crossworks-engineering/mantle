import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must be set (run `supabase start` and copy from .env.example)');

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  // We don't manage the auth, storage, or extensions schemas — Supabase owns those.
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
});
