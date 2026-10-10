import { AsyncLocalStorage } from 'node:async_hooks';
import { setDatabaseErrorWatch } from './index';

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
  const value = await store.run(texts, fn);
  return { value, texts: texts.texts };
}
