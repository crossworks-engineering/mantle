import { AsyncLocalStorage } from 'node:async_hooks';
import {
  databaseErrorPublic,
  isDatabaseError,
  isProviderHttpFailure,
  isRuntimeFault,
  isWatchedProviderFailure,
  publicProviderErrorMessage,
  RUNTIME_ERROR_PUBLIC,
  setDatabaseErrorWatch,
} from './index';

/**
 * Node-only half of the database error watch (workspaces W3): kept out of
 * index.ts so browser bundles that import @mantle/std never see
 * node:async_hooks.
 */
const store = new AsyncLocalStorage<{ texts: string[]; errors: unknown[] }>();
setDatabaseErrorWatch(() => store.getStore());

/**
 * Run `fn` (one tool call for a caller outside the server) and collect the
 * text of every database error errorMessage turned into a string during it
 * (and, since the A10 lows, every runtime fault's and every model
 * provider's HTTP failure's: publicToolError maps each to its fixed text).
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
    if (!isDatabaseError(err) && at >= 0 && isWatchedProviderFailure(texts.errors[at])) {
      // A provider's HTTP failure (A10 lows): one thrown as itself goes on
      // to its own mappers (toolThrowText, the domain row); a message of
      // our own that repeats its text goes on as its fixed sentence.
      if (isProviderHttpFailure(err)) throw err;
      throw new Error(publicProviderErrorMessage(texts.errors[at], 'watchDatabaseErrors'), {
        cause: err,
      });
    }
    if (!isDatabaseError(err) && at >= 0 && isRuntimeFault(texts.errors[at])) {
      // Likewise a runtime fault's text (the A8 finding F2): a fixed text.
      console.error('[watchDatabaseErrors] runtime fault in a thrown message:', err);
      throw new Error(RUNTIME_ERROR_PUBLIC, { cause: err });
    }
    if (!isDatabaseError(err) && (/Failed query:/.test(text) || at >= 0)) {
      console.error('[watchDatabaseErrors] database error in a thrown message:', err);
      throw new Error(databaseErrorPublic(at >= 0 ? texts.errors[at] : err), { cause: err });
    }
    throw err;
  }
}
