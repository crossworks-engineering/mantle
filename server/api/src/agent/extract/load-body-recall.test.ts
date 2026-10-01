/**
 * A `recall` node (a Recall v2 memory MAP) indexes METADATA ONLY.
 *
 * Its cards are rows in recall_nodes, served through the recall tools. If the
 * extractor read them into the general corpus, prompt and map text would come
 * back out of ordinary search and team-turn retrieval — which is exactly what
 * the design excludes. The node type exists from R1, so an unguarded
 * extractor would have started indexing card text the moment R2 wrote the
 * first map.
 *
 * Title and enter-when only, the same shape as secrets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return { ...actual, db: { ...actual.db, select: vi.fn(), update: vi.fn() } };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    recordSkippedTrace: vi.fn(),
    step: vi.fn(async (_spec: unknown, fn: (handle: unknown) => unknown) =>
      fn({ ok: vi.fn(), fail: vi.fn() }),
    ),
  };
});

import { loadExtractableBody } from './load-body';

const WORKER = { slug: 'extractor', model: 'test' };

/** A map node as R2 will write it: the enter-when line lives in `data`. */
function recallNode(data: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    ownerId: 'o1',
    type: 'recall',
    title: 'Fleet and access',
    tags: [],
    data,
  } as unknown as Parameters<typeof loadExtractableBody>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadExtractableBody — a Recall map', () => {
  it('indexes the title and the enter-when line, and says where the content is', async () => {
    const res = await loadExtractableBody(
      recallNode({ enterWhen: 'Working on any box in the fleet' }),
      'o1',
      WORKER as never,
      {},
    );
    expect(res.ok).toBe(true);
    const body = res.ok ? res.rawBody : '';
    expect(body).toContain('Fleet and access');
    expect(body).toContain('Working on any box in the fleet');
    expect(body).toContain('served via the recall tools');
  });

  it('never reaches for the cards', async () => {
    // The branch returns before any select(). A future edit that reads
    // recall_nodes here would leak prompt text into general search, and this
    // is the assertion that catches it.
    const { db } = await import('@mantle/db');
    await loadExtractableBody(recallNode(), 'o1', WORKER as never, {});
    expect(db.select).not.toHaveBeenCalled();
  });

  it('omits the enter-when line when the map has none', async () => {
    const res = await loadExtractableBody(recallNode(), 'o1', WORKER as never, {});
    const body = res.ok ? res.rawBody : '';
    expect(body).toContain('Fleet and access');
    expect(body).not.toContain('Enter when:');
  });
});
