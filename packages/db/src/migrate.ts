/**
 * Apply Mantle's Drizzle migrations to the local (or remote) Postgres.
 * Supabase platform migrations are applied separately by `supabase start`
 * / `supabase db reset` — those own extensions and the `mantle` bucket.
 *
 * Env loading is handled by Node's `--env-file-if-exists=.env.local`
 * in `package.json`; this script just trusts `process.env`.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  const sql = postgres(url, { max: 1, prepare: false });
  const db = drizzle(sql);
  console.log('Applying Drizzle migrations to', url.replace(/:[^@]+@/, ':***@'));
  await migrate(db, { migrationsFolder: './migrations' });
  console.log('Done.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
