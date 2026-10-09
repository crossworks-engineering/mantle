/**
 * Remove one brain's per-database viewer logins (MANTLE_VIEWER_ROLES_PER_DATABASE):
 * the `mantle_view_<level>_<database>` roles are cluster objects, so dropping
 * the brain's database or its worktree leaves them behind. Run at a throwaway
 * brain's teardown; scripts/rm-worktree.sh runs it for a worktree whose
 * `.env.local` sets the flag. Leaves the database itself alone.
 *
 *   pnpm -C packages/db drop-viewer-logins <database>
 *
 * DATABASE_URL (from server/web/.env.local by default) is any database on the
 * cluster, as a role that may drop roles (migrate's). A no-op when the logins
 * are gone already. Never touches the shared mantle_view_* roles.
 */
import postgres from 'postgres';
import { env } from '@mantle/config';
import { dropViewerLogins } from './viewer-roles';

async function main() {
  const database = process.argv[2];
  if (!database) throw new Error('usage: drop-viewer-logins <database>');
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const dropped = await dropViewerLogins(sql, database);
    console.log(
      dropped.length === 0
        ? `No per-database viewer logins for "${database}".`
        : `Dropped ${dropped.join(', ')}.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
