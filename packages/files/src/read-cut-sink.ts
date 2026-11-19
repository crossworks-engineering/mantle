/**
 * Where a reader says it read in part (./read-cut.ts): one sink per read,
 * carried through the async calls under it, so a reader deep in the text
 * dispatch (a sheet, a drawing, a picture gate) says so without every caller
 * between it and the node's write passing a value along.
 *
 *  - The extractor opens one for each node it reads (extractNode) and writes
 *    what was said onto the node at the end (data.read_cut).
 *  - A parser job opens one for its job (server/parser/src/jobs.ts) and sends
 *    what was said in its answer as `cuts`; the parser client says them again
 *    in the caller's sink (./parser-client.ts). So a cut in the parser
 *    process reaches the node like one in the brain.
 *
 * With no sink open (a chat turn's attachment, a thumbnail, a test), a note
 * goes nowhere: the caller did not ask.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { addReadCut, readCutsOf, type ReadCutValue, type ReadCuts } from './read-cut';

type Sink = { cuts: ReadCuts };

const store = new AsyncLocalStorage<Sink>();

/** Run `fn` with a fresh sink; its cuts are read with {@link currentReadCuts}
 *  (inside) or returned with the value. Nested sinks are separate. */
export async function withReadCutSink<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; cuts: ReadCuts }> {
  const sink: Sink = { cuts: {} };
  const value = await store.run(sink, fn);
  return { value, cuts: sink.cuts };
}

/** Say that the read under way took only part of an input. Two notes of one
 *  key add up (two sheets cut, two pictures left out). A note that left
 *  nothing out (all of a known total read) is no cut. */
export function noteReadCut(key: string, cut: ReadCutValue): void {
  const sink = store.getStore();
  if (!sink) return;
  if (cut.total !== undefined && cut.read >= cut.total && !cut.atLeast) return;
  // Own entries only: a key like `constructor` is no inherited value.
  sink.cuts[key] = addReadCut(Object.hasOwn(sink.cuts, key) ? sink.cuts[key] : undefined, cut);
}

/** Say again the cuts another process sent (a parser answer's `cuts`),
 *  checked first. */
export function noteReadCuts(raw: unknown): void {
  if (!store.getStore()) return;
  for (const [key, cut] of Object.entries(readCutsOf(raw))) noteReadCut(key, cut);
}

/** The cuts said so far in the open sink ({} with none). */
export function currentReadCuts(): ReadCuts {
  return { ...(store.getStore()?.cuts ?? {}) };
}

/** True when a sink is open: a reader may then count what it would not
 *  count otherwise. */
export function readCutSinkOpen(): boolean {
  return store.getStore() !== undefined;
}
