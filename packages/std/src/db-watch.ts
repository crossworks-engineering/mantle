import { AsyncLocalStorage } from 'node:async_hooks';
import { databaseErrorPublic, isDatabaseError, setDatabaseErrorWatch } from './index';

/**
 * Node-only half of the database error watch (workspaces W3): kept out of
 * index.ts so browser bundles that import @mantle/std never see
 * node:async_hooks.
 */
const store = new AsyncLocalStorage<{ texts: string[]; errors: unknown[] }>();
setDatabaseErrorWatch(() => store.getStore());

/**
 * Run `fn` (one tool call for a caller outside the server) and collect the
 * text of every database error errorMessage turned into a string during it.
 */
export async function watchDatabaseErrors<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; texts: readonly string[]; errors: readonly unknown[] }> {
  const texts = { texts: [] as string[], errors: [] as unknown[] };
  try {
    const value = await store.run(texts, fn);
    return { value, texts: texts.texts, errors: texts.errors };
  } catch (err) {
    // A thrown error of our own whose message repeats a database text seen
    // in the call (or drizzle's "Failed query") carries no cause to detect it
    // by: it goes on as a generic one, logged in full.
    const text = err instanceof Error ? err.message : String(err);
    const at = texts.texts.findIndex((t) => text.includes(t));
    if (!isDatabaseError(err) && (/Failed query:/.test(text) || at >= 0)) {
      console.error('[watchDatabaseErrors] database error in a thrown message:', err);
      throw new Error(databaseErrorPublic(at >= 0 ? texts.errors[at] : err), { cause: err });
    }
    throw err;
  }
}
