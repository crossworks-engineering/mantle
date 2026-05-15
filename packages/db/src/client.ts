import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

declare global {
  // eslint-disable-next-line no-var
  var __mantleSql: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __mantleDb: PostgresJsDatabase<typeof schema> | undefined;
}

/**
 * Lazy singleton. Initialised on first call so Next.js can build pages that
 * don't actually query the DB without DATABASE_URL set (e.g. /login).
 */
function getDb(): PostgresJsDatabase<typeof schema> {
  if (globalThis.__mantleDb) return globalThis.__mantleDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  const sql = globalThis.__mantleSql ?? postgres(url, { max: 10, prepare: false });
  if (process.env.NODE_ENV !== 'production') globalThis.__mantleSql = sql;
  const client = drizzle(sql, { schema });
  if (process.env.NODE_ENV !== 'production') globalThis.__mantleDb = client;
  return client;
}

// Proxy that defers initialisation until the first property access.
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    return Reflect.get(getDb() as object, prop);
  },
});

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };
