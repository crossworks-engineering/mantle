import { AsyncLocalStorage } from 'node:async_hooks';
import { DATABASE_ERROR_PUBLIC, isDatabaseError, setDatabaseErrorWatch } from './index';

/**
 * Node-only half of the database error watch (workspaces W3): kept out of
 * index.ts so browser bundles that import @mantle/std never see
 * node:async_hooks.
 */
const store = new AsyncLocalStorage<{ texts: string[] }>();
setDatabaseErrorWatch(() => store.getStore());

/**
 * Run `fn` (one tool call for a caller outside the server) and collect the
 * text of every database error errorMessage turned into a string during it.
 */
export async function watchDatabaseErrors<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; texts: readonly string[] }> {
  const texts = { texts: [] as string[] };
  try {
    const value = await store.run(texts, fn);
    return { value, texts: texts.texts };
  } catch (err) {
    // A thrown error of our own whose message repeats a database text seen
    // in the call (or drizzle's "Failed query") carries no cause to detect it
    // by: it goes on as a generic one, logged in full.
    const text = err instanceof Error ? err.message : String(err);
    if (
      !isDatabaseError(err) &&
      (/Failed query:/.test(text) || texts.texts.some((t) => text.includes(t)))
    ) {
      console.error('[watchDatabaseErrors] database error in a thrown message:', err);
      throw new Error(DATABASE_ERROR_PUBLIC, { cause: err });
    }
    throw err;
  }
}
