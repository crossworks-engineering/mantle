/**
 * The extractor's admission gate: which nodes get an LLM spent on them, and
 * why the rest do not.
 *
 * This is the half of `extractNode` that had no test at all. It is also the
 * half where a mistake is expensive AND silent: refusing a node that should
 * have been indexed looks like "nothing happened", and admitting one that
 * should have been refused is worse — a conversation digest re-summarised from
 * its title overwrites the real digest, and a metadata-only file that reaches
 * the LLM is precisely the content the owner asked to keep out of the brain.
 *
 * ORDER is the contract, not just the set of checks, so the tests below assert
 * what each refusal DID as well as what it returned:
 *
 *  - a refusal spends nothing downstream (no embed, no LLM key check);
 *  - the two side passes (auto-table, embedded images) run for a node the type
 *    allowlist then refuses — a spreadsheet must still reach /tables when
 *    `file` is not in target_types;
 *  - metadata-only decides before the key pre-flight (it needs no LLM) and
 *    before the already-extracted guard (a mode flip must re-run);
 *  - already-extracted requires the completion marker as well as summary +
 *    embedding, because those two are written FIRST and a pass that died after
 *    them must retry rather than skip forever.
 *
 * Every refusal also records a `skipped` trace with a disposition, which is
 * what makes "I uploaded X and nothing happened" answerable in /traces; each
 * case pins the disposition it emits.
 *
 * The db, the embedder, the indexing resolver and the two side passes are
 * stubbed; the gate's own ordering and branching are real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updates: [] as unknown[],
  resolveExtractor: vi.fn(),
  resolveChatKey: vi.fn(),
  resolveEffectiveIndexing: vi.fn(),
  effectiveBrainDepth: vi.fn(),
  metadataSpineText: vi.fn(() => 'spine text'),
  embed: vi.fn(),
  recordSkippedTrace: vi.fn(),
  autoTable: vi.fn(),
  embeddedImages: vi.fn(),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => h.selectQueue.shift() ?? []),
  };
  const updateChain = {
    set: vi.fn((patch: unknown) => {
      h.updates.push(patch);
      return { where: vi.fn(async () => undefined) };
    }),
  };
  const db = {
    ...actual.db,
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { ...actual, db };
});
vi.mock('@mantle/embeddings', () => ({ embed: h.embed }));
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    resolveEffectiveIndexing: h.resolveEffectiveIndexing,
    effectiveBrainDepth: h.effectiveBrainDepth,
    metadataSpineText: h.metadataSpineText,
  };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return { ...actual, recordSkippedTrace: h.recordSkippedTrace };
});
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return { ...actual, resolveChatKey: h.resolveChatKey };
});
vi.mock('./model', () => ({ resolveExtractor: h.resolveExtractor }));
vi.mock('./auto-table', () => ({ maybeAutoTableSpreadsheet: h.autoTable }));
vi.mock('./images', () => ({ maybeExtractEmbeddedImages: h.embeddedImages }));

import { admitForExtraction } from './gates';
import { sqlValues } from './test-support';

const WORKER = { id: 'w1', slug: 'extractor', params: {}, apiKeyId: null };

/** A node row with only the fields the gate reads. */
function node(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    ownerId: 'o1',
    type: 'note',
    title: 'A note',
    tags: [],
    data: {},
    embedding: null,
    parentId: null,
    ...over,
  };
}

/** Every payload written by the update patches so far, as one string. */
function writtenJson(): string {
  return h.updates
    .flatMap((patch) => Object.values(patch as Record<string, unknown>))
    .flatMap((v) => sqlValues(v))
    .join(' ');
}

/** The disposition of the single skipped trace recorded, if any. */
function disposition(): string | undefined {
  const call = h.recordSkippedTrace.mock.calls[0]?.[0] as { disposition?: string } | undefined;
  return call?.disposition;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.updates.length = 0;
  h.resolveExtractor.mockResolvedValue(WORKER);
  h.resolveChatKey.mockResolvedValue({ ok: true });
  h.resolveEffectiveIndexing.mockResolvedValue({ effective: 'full', source: 'default' });
  h.effectiveBrainDepth.mockReturnValue('full');
  h.embed.mockResolvedValue([0.1, 0.2]);
  h.autoTable.mockResolvedValue(undefined);
  h.embeddedImages.mockResolvedValue(undefined);
  h.recordSkippedTrace.mockResolvedValue(undefined);
});

describe('admitForExtraction — refusals', () => {
  it('refuses with no extractor worker, before loading the node', async () => {
    h.resolveExtractor.mockResolvedValue(null);
    const res = await admitForExtraction('n1', 'o1');
    expect(res.proceed).toBe(false);
    expect(disposition()).toBe('no_extractor_worker');
    // Nothing else may run: there is no worker to name in a later trace.
    expect(h.autoTable).not.toHaveBeenCalled();
  });

  it('refuses a node that is gone', async () => {
    h.selectQueue.push([]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('node_not_found');
  });

  it('refuses a hard-skip type whatever the allowlist says', async () => {
    // `branch` is refused in code, not in config — a worker configured with
    // '*' must not reach folder rows.
    h.selectQueue.push([node({ type: 'branch' })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('hard_skip_type');
    expect(h.autoTable).not.toHaveBeenCalled();
  });

  it.each([
    ['a conversation-digest TAG', { type: 'note', tags: ['conversation-digest'] }],
    ['a conversation_digest KIND', { type: 'note', data: { kind: 'conversation_digest' } }],
  ])('refuses %s — re-summarising an authored summary destroys it', async (_label, over) => {
    h.selectQueue.push([node(over)]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('conversation_digest');
  });

  it('embeds a telegram turn but never admits it for summarising', async () => {
    h.selectQueue.push([node({ type: 'telegram_message', data: { text: 'hello there' } })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('telegram_embed_only');
    // The point of the branch: searchable, but no LLM spent per line.
    expect(h.embed).toHaveBeenCalledWith('o1', 'hello there');
    expect(h.updates[0]).toMatchObject({ embedding: [0.1, 0.2] });
  });

  it('does not re-embed a telegram turn that already has a vector', async () => {
    h.selectQueue.push([
      node({ type: 'telegram_message', data: { text: 'hello' }, embedding: [0.9] }),
    ]);
    await admitForExtraction('n1', 'o1');
    expect(h.embed).not.toHaveBeenCalled();
  });

  it('refuses a type outside the allowlist — but only AFTER the side passes', async () => {
    // A spreadsheet must still reach /tables when `file` is not in
    // target_types, which is why auto-table is not behind this gate.
    h.resolveExtractor.mockResolvedValue({ ...WORKER, params: { target_types: ['note'] } });
    h.selectQueue.push([node({ type: 'file' })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('type_not_in_allowlist');
    expect(h.autoTable).toHaveBeenCalled();
    expect(h.embeddedImages).toHaveBeenCalled();
  });

  it('refuses when the worker has no usable key, naming the resolver disposition', async () => {
    h.resolveChatKey.mockResolvedValue({ ok: false, disposition: 'missing_api_key', detail: 'x' });
    h.selectQueue.push([node()]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('missing_api_key');
  });

  it('refuses a node a PRIOR RUN FULLY COMPLETED', async () => {
    h.selectQueue.push([
      node({ data: { summary: 's', extract_completed_at: '2026-01-01' }, embedding: [0.5] }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('already_extracted');
  });

  it('ADMITS a node whose prior run died after the summary — the retry hole', async () => {
    // summary + embedding are written first, so checking only those made every
    // pg-boss retry skip a pass that had failed at chunks/entities/facts. The
    // completion marker is what distinguishes them.
    h.selectQueue.push([node({ data: { summary: 's' }, embedding: [0.5] })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
  });
});

describe('admitForExtraction — metadata-only files', () => {
  beforeEach(() => {
    h.resolveEffectiveIndexing.mockResolvedValue({
      effective: 'metadata',
      source: 'folder',
      sourcePath: 'files.private',
    });
  });

  it('indexes the spine and refuses, without an LLM key check', async () => {
    h.selectQueue.push([node({ type: 'file' })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('metadata_only_indexed');
    // It decides BEFORE the key pre-flight, because it needs no model.
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    expect(h.embed).toHaveBeenCalledWith('o1', 'spine text');
  });

  it('withholds the completion marker when the embedder is down, so it retries', async () => {
    h.embed.mockRejectedValue(new Error('embedder offline'));
    h.selectQueue.push([node({ type: 'file' })]);
    await admitForExtraction('n1', 'o1');
    // The summary + FTS still index the spine; the marker is what the next
    // notify checks before re-running for the vector.
    expect(writtenJson()).toContain('"summary":"spine text"');
    expect(writtenJson()).not.toContain('extract_completed_at');
  });

  it('skips work when the metadata pass is already current', async () => {
    h.selectQueue.push([
      node({
        type: 'file',
        data: { indexing_applied: 'metadata', summary: 's', extract_completed_at: 'x' },
        embedding: [0.5],
      }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('metadata_only_current');
    expect(h.embed).not.toHaveBeenCalled();
  });

  it('re-runs on a full→metadata flip even though the node looks extracted', async () => {
    // The already-extracted guard cannot tell WHICH mode produced the summary,
    // which is why metadata-only carries its own idempotency and sits in front
    // of it. A node stamped `full` must not be waved through as current.
    h.selectQueue.push([
      node({
        type: 'file',
        data: { indexing_applied: 'full', summary: 's', extract_completed_at: 'x' },
        embedding: [0.5],
      }),
    ]);
    expect(disposition()).toBeUndefined();
    const res = await admitForExtraction('n1', 'o1');
    expect(res.proceed).toBe(false);
    expect(disposition()).toBe('metadata_only_indexed');
  });
});

describe('admitForExtraction — admission', () => {
  it('hands the sequencer the node, worker, params and depth', async () => {
    const row = node({ data: { existing: true } });
    h.resolveExtractor.mockResolvedValue({ ...WORKER, params: { extract_facts: false } });
    h.selectQueue.push([row]);
    const res = await admitForExtraction('n1', 'o1');
    expect(res).toMatchObject({
      proceed: true,
      node: row,
      params: { extract_facts: false },
      retrievalOnly: false,
      existingData: { existing: true },
    });
    expect(h.recordSkippedTrace).not.toHaveBeenCalled();
  });

  it('reports retrieval depth so the sequencer can skip L4', async () => {
    // documentation collections index to L5 but must not put system-meta into
    // the personal profile + graph.
    h.effectiveBrainDepth.mockReturnValue('retrieval');
    h.selectQueue.push([node({ type: 'documentation' })]);
    const res = await admitForExtraction('n1', 'o1');
    expect(res).toMatchObject({ proceed: true, retrievalOnly: true });
  });

  it('stamps indexing_applied=full on a file falling through to a full pass', async () => {
    h.selectQueue.push([node({ type: 'file' })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
    // The counterpart to the metadata path: without this stamp a later flip to
    // metadata has no way to know there is content to reap.
    expect(writtenJson()).toContain('indexing_applied');
  });

  it('does not re-stamp a file already marked full', async () => {
    h.selectQueue.push([node({ type: 'file', data: { indexing_applied: 'full' } })]);
    await admitForExtraction('n1', 'o1');
    expect(h.updates).toEqual([]);
  });

  it('lets a fatal auto-table failure abort the whole pass', async () => {
    // A DWG sidecar failure means every pass depends on the same dead
    // exchange: better to fail and retry than to complete a node that quietly
    // lost its registry workbook.
    h.autoTable.mockRejectedValue(
      Object.assign(new Error('sidecar down'), {
        fatalToExtract: true,
      }),
    );
    h.selectQueue.push([node({ type: 'file' })]);
    await expect(admitForExtraction('n1', 'o1')).rejects.toThrow(/sidecar down/);
  });

  it('swallows a NON-fatal auto-table failure and carries on', async () => {
    h.autoTable.mockRejectedValue(new Error('one bad sheet'));
    h.selectQueue.push([node({ type: 'note' })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
  });
});
