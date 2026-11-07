/**
 * The extractor and a per-login row (`nodes.login_id` set: a chat, a file
 * sent in one). Entities and their edges name no login and every
 * Admin scope reads them (migration 0265), so such a row never feeds the
 * entity graph: no entity reconciliation, no relation pass. Its own index
 * (the summary, the text, the chunks its owner searches) is written as for
 * any row, and its facts (which copy the node's login) still run, naming no
 * entity. The control: the same image with no login runs both passes.
 *
 * Every module around the pass is stubbed; the extractor's own branching is
 * real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  node: null as null | Record<string, unknown>,
  writeContentIndex: vi.fn(async () => undefined),
  writeRetrievalChunks: vi.fn(async () => undefined),
  reconcileEntities: vi.fn(async () => new Map([['acme', 'e1']])),
  processRelations: vi.fn(async () => undefined),
  processFacts: vi.fn(
    async (..._args: unknown[]) => ({ ADD: 1, UPDATE: 0, DELETE: 0, NOOP: 0, retired: 0 }) as const,
  ),
  retireUnassertedFacts: vi.fn(async () => undefined),
  supersedeFileVersions: vi.fn(async () => undefined),
}));

const PARSED = {
  summary: 'A photo sent in a chat.',
  model: 'fake/vision',
  entities: [{ name: 'Acme', type: 'org' }],
  facts: [{ text: 'Acme ships pumps.', entities: [{ name: 'Acme', type: 'org' }] }],
  relations: [{ subject: 'Acme', predicate: 'works_with', object: 'Lister' }],
};

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const db = {
    ...actual.db,
    execute: vi.fn(async () => [{ v: '1', w: null }]),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
  };
  return { ...actual, db, bumpWorkerUsage: vi.fn(async () => undefined) };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    startTrace: async (_t: unknown, fn: () => Promise<unknown>) => fn(),
    recordSkippedTrace: vi.fn(async () => undefined),
  };
});
vi.mock('@mantle/runtime/agent', () => ({
  resolveChatRoutes: () => ({ primary: { provider: 'local', model: 'fake' }, backup: null }),
}));
vi.mock('@mantle/voice', () => ({
  getChatAdapter: () => ({ providerId: 'local', adapterName: 'fake-chat', chat: vi.fn() }),
}));
vi.mock('@mantle/content', () => ({ isDocumentTitleMention: () => false }));
vi.mock('@mantle/files', () => ({
  withParserScope: (_s: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./extract/parser-failures', () => ({ nodeParserFailures: () => ({}) }));
vi.mock('./extract/gates', () => ({
  admitForExtraction: async () => ({
    proceed: true,
    node: h.node,
    worker: { id: 'w1', slug: 'extractor', provider: 'local', model: 'fake/vision' },
    params: { extract_facts: true },
    retrievalOnly: false,
    existingData: {},
  }),
}));
vi.mock('./extract/load-body', () => ({
  loadExtractableBody: async () => ({ ok: true, rawBody: 'Acme works with Lister on pumps.' }),
}));
vi.mock('./extract/model', () => ({
  reusesTableSummary: () => false,
  runExtractorModel: async () => PARSED,
  chatComplete: vi.fn(),
}));
vi.mock('./extract/index-writes', () => ({
  buildTableIndexPieces: async () => ({ tableProfilePieces: [], tableSchemaDigest: null }),
  writeContentIndex: h.writeContentIndex,
  writeRetrievalChunks: h.writeRetrievalChunks,
}));
vi.mock('./extract/supersede', () => ({ supersedeFileVersions: h.supersedeFileVersions }));
vi.mock('./extract/entities', () => ({
  reconcileEntities: h.reconcileEntities,
  processRelations: h.processRelations,
}));
vi.mock('./extract/facts', () => ({
  processFacts: h.processFacts,
  retireUnassertedFacts: h.retireUnassertedFacts,
}));

import { extractNode } from './extractor';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const LOGIN = '00000000-0000-4000-8000-0000000000a1';

const image = (loginId: string | null) => ({
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: OWNER,
  type: 'file',
  title: 'photo-2026-11-06.png',
  path: 'files',
  data: { mimeType: 'image/png' },
  loginId,
});

describe('the extractor and a per-login row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a per-login image: its own index and chunks, its facts, no entities, no relations', async () => {
    h.node = image(LOGIN);
    await extractNode(String(h.node.id), OWNER);
    expect(h.writeContentIndex).toHaveBeenCalledTimes(1);
    expect(h.writeRetrievalChunks).toHaveBeenCalledTimes(1);
    expect(h.reconcileEntities).not.toHaveBeenCalled();
    expect(h.processRelations).not.toHaveBeenCalled();
    // Its facts carry its login; they name no entity (an empty map).
    expect(h.processFacts).toHaveBeenCalledTimes(1);
    const entityMap = h.processFacts.mock.calls[0]![5] as Map<string, string>;
    expect(entityMap.size).toBe(0);
  });

  it('the same image with no login runs both passes (the control)', async () => {
    h.node = image(null);
    await extractNode(String(h.node.id), OWNER);
    expect(h.writeContentIndex).toHaveBeenCalledTimes(1);
    expect(h.writeRetrievalChunks).toHaveBeenCalledTimes(1);
    expect(h.reconcileEntities).toHaveBeenCalledTimes(1);
    expect(h.processRelations).toHaveBeenCalledTimes(1);
    const entityMap = h.processFacts.mock.calls[0]![5] as Map<string, string>;
    expect(entityMap.get('acme')).toBe('e1');
  });
});
