/**
 * One connection as the migrator (DATABASE_URL, the role that runs the
 * migrations), opened for one piece of work and closed after (arch A9):
 * what the runtime role may not do and the app still must, the workspaces
 * switch (client.ts, executeAsMigrator). At most one connection, at boot or
 * at the first owner: connection-ceiling.test.ts counts it as one-shot.
 */
import postgres from 'postgres';
import { env } from '@mantle/config';
import { onPgNotice } from './actor';

export async function withMigratorConnection<T>(
  fn: (sql: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const sql = postgres(url, { max: 1, prepare: false, onnotice: onPgNotice });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
