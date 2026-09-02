/**
 * Prepare an EMPTY Postgres database the way the compose stack's first boot
 * does — extensions + the hand-managed `auth` schema — so `migrate.ts` can
 * replay 0000→latest against it. The production image never needs this: the
 * Postgres container runs infra/postgres/init/*.sql itself on first cluster
 * init. CI (a bare service container) and a developer's scratch database do.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/mantle_ci pnpm -C packages/db init-scratch
 *   DATABASE_URL=… pnpm -C packages/db migrate
 *
 * Idempotent: every statement in those files is IF NOT EXISTS.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  const initDir = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/postgres/init');
  const files = readdirSync(initDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const sql = postgres(url, { max: 1, prepare: false });
  console.log('Initialising', url.replace(/:[^@]+@/, ':***@'), 'from', files.join(', '));
  try {
    for (const f of files) {
      await sql.unsafe(readFileSync(join(initDir, f), 'utf8'));
      console.log('  ✓', f);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('init-scratch failed:', err);
  process.exit(1);
});
