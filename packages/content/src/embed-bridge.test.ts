import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetRecallEmbedderForTests,
  getRecallEmbedder,
  hasRecallEmbedder,
  registerRecallEmbedder,
} from './embed-bridge';

/**
 * The bridge's whole job is to fail LOUDLY. Its caller
 * (`embedPendingRecallPrompts`, inside `recallAfterPageWrite`) is
 * fire-and-forget on a path contractually forbidden from throwing, so an
 * unregistered embedder cannot surface as a broken page write — it can only
 * surface as prompts that never get a vector, which looks like nothing at all
 * until `recall_match` stops returning hits.
 *
 * Hence: throw, don't return 0. These cases pin that choice.
 */
afterEach(() => {
  __resetRecallEmbedderForTests();
});

describe('recall embedder bridge', () => {
  it('throws a named, actionable error when nothing registered', () => {
    __resetRecallEmbedderForTests();
    expect(() => getRecallEmbedder()).toThrowError(/no embedder registered in this process/);
    expect(() => getRecallEmbedder()).toThrowError(/registerRecallEmbedder/);
  });

  it('reports registration state without throwing', () => {
    __resetRecallEmbedderForTests();
    expect(hasRecallEmbedder()).toBe(false);
    registerRecallEmbedder(async () => []);
    expect(hasRecallEmbedder()).toBe(true);
  });

  it('hands back the registered embedder and passes arguments through', async () => {
    const seen: { ownerId: string; texts: string[] }[] = [];
    registerRecallEmbedder(async (ownerId, texts) => {
      seen.push({ ownerId, texts });
      return texts.map(() => [0.1, 0.2]);
    });
    const vectors = await getRecallEmbedder()('owner-1', ['a', 'b']);
    expect(seen).toEqual([{ ownerId: 'owner-1', texts: ['a', 'b'] }]);
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ]);
  });

  it('is last-write-wins, so a re-register replaces rather than stacks', async () => {
    registerRecallEmbedder(async () => [[1]]);
    registerRecallEmbedder(async () => [[2]]);
    await expect(getRecallEmbedder()('o', ['x'])).resolves.toEqual([[2]]);
  });
});
