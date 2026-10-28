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
  wheres: [] as unknown[],
  resolveExtractor: vi.fn(),
  resolveChatKey: vi.fn(),
  resolveEffectiveIndexing: vi.fn(),
  effectiveBrainDepth: vi.fn(),
  metadataSpineText: vi.fn(() => 'spine text'),
  embed: vi.fn(),
  recordSkippedTrace: vi.fn(),
  autoTable: vi.fn(),
  embeddedImages: vi.fn(),
  llmWorkAllowed: vi.fn(),
  readNodeBodyLocal: vi.fn(),
  writeRetrievalChunks: vi.fn(),
  writePublishedSummaryIndex: vi.fn(),
  summarizeAppForIndex: vi.fn(),
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
      // Awaitable as is, or with .returning() (the re-embed's guarded write).
      return {
        where: vi.fn((cond: unknown) => {
          h.wheres.push(cond);
          return Object.assign(Promise.resolve(undefined), {
            returning: vi.fn(async () => [{ id: 'n1' }]),
          });
        }),
      };
    }),
  };
  const db = {
    ...actual.db,
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    execute: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return {
    ...actual,
    db,
    // The heads helpers (workspaces plan U1) open their own transaction on
    // the real pool; here they run the callback on the mocked db.
    withHeads: async (_ids: unknown, _mode: unknown, fn: (tx: unknown) => unknown) => fn(db),
    withNodeInsertHeads: async (_o: unknown, _i: unknown, fn: (tx: unknown) => unknown) => fn(db),
    withNodeDeleteHeads: async (_ids: unknown, fn: (tx: unknown) => unknown) => fn(db),
    withDeadlockRetry: async (fn: () => unknown) => fn(),
    llmWorkAllowed: h.llmWorkAllowed,
  };
});
vi.mock('@mantle/embeddings', () => ({
  embed: h.embed,
  digestEmbedText: (label: string, summary: string) => `${label}\n${summary}`,
}));
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
vi.mock('./load-body', () => ({ readNodeBodyLocal: h.readNodeBodyLocal }));
vi.mock('./index-writes', () => ({
  writeRetrievalChunks: h.writeRetrievalChunks,
  writePublishedSummaryIndex: h.writePublishedSummaryIndex,
}));
vi.mock('./app-summary', () => ({ summarizeAppForIndex: h.summarizeAppForIndex }));

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
  h.wheres.length = 0;
  h.resolveExtractor.mockResolvedValue(WORKER);
  h.resolveChatKey.mockResolvedValue({ ok: true });
  h.resolveEffectiveIndexing.mockResolvedValue({ effective: 'full', source: 'default' });
  h.effectiveBrainDepth.mockReturnValue('full');
  h.embed.mockResolvedValue([0.1, 0.2]);
  h.autoTable.mockResolvedValue(undefined);
  h.embeddedImages.mockResolvedValue(undefined);
  h.recordSkippedTrace.mockResolvedValue(undefined);
  h.llmWorkAllowed.mockResolvedValue(true);
  h.readNodeBodyLocal.mockResolvedValue('the body');
  h.writeRetrievalChunks.mockResolvedValue(undefined);
  h.writePublishedSummaryIndex.mockResolvedValue(true);
  h.summarizeAppForIndex.mockImplementation(async (n: unknown) => ({ node: n, status: 'none' }));
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

  it('refuses a node the brain does not own, before any side pass', async () => {
    // A member's personal item (member logins Phase 2) must never be learned,
    // whichever commit path notified the extractor.
    h.selectQueue.push([node({ ownerId: 'personal-space-1' })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('not_brain_owner');
    expect(h.autoTable).not.toHaveBeenCalled();
    expect(h.embeddedImages).not.toHaveBeenCalled();
    expect(h.embed).not.toHaveBeenCalled();
  });

  it('refuses a Forum archive page before any pass, whatever the allowlist says', async () => {
    // Member logins Phase 6: the archive holds private topics too and must
    // never be indexed. Nothing downstream may run, not even the free-looking
    // side passes or the local embedder.
    h.resolveExtractor.mockResolvedValue({ ...WORKER, params: { target_types: ['*'] } });
    h.selectQueue.push([node({ type: 'page', data: { source: 'forum-archive' } })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('extract_exempt');
    expect(h.autoTable).not.toHaveBeenCalled();
    expect(h.embeddedImages).not.toHaveBeenCalled();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it('refuses an unreviewed team request before any pass (member text, no admin read yet)', async () => {
    // Audit F08: a member asking the team agent to file ten requests must not
    // start ten extractor runs before an admin has looked at any of them.
    h.selectQueue.push([
      node({ type: 'task', data: { source: 'team-request', body: 'please change X' } }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('extract_exempt');
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.resolveChatKey).not.toHaveBeenCalled();
  });

  it('admits a team request once an admin has acted on it (reviewed_at)', async () => {
    h.selectQueue.push([
      node({
        type: 'task',
        data: { source: 'team-request', reviewed_at: '2026-09-28T10:00:00.000Z', body: 'x' },
      }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
  });

  it('admits an ordinary page (the exemption is the source, not the type)', async () => {
    h.selectQueue.push([node({ type: 'page', data: { source: 'editor' } })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
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
    h.selectQueue.push([node({ ...over, embedding: [0.3] })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('conversation_digest');
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.resolveChatKey).not.toHaveBeenCalled();
  });

  it.each([
    ['conversation_digest', { kind: 'conversation_digest', topic: 'Pumps', summary: 'We talked.' }],
    ['chat_archive', { kind: 'chat_archive', topic: 'Pumps', summary: 'We talked.' }],
  ])(
    'rebuilds a missing vector of a %s from its topic and summary, no model (A10 #7 M2)',
    async (kind, data) => {
      h.selectQueue.push([node({ title: 'Renamed', data, embedding: null })]);
      expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
      expect(disposition()).toBe(kind);
      expect(h.embed).toHaveBeenCalledWith('o1', 'Pumps\nWe talked.');
      expect(h.updates).toContainEqual({ embedding: [0.1, 0.2] });
      expect(h.resolveChatKey).not.toHaveBeenCalled();
    },
  );

  it('leaves an authored summary to the drain when its embed fails (not terminal)', async () => {
    h.embed.mockRejectedValueOnce(new Error('embedder down'));
    h.selectQueue.push([node({ data: { kind: 'chat_archive', summary: 's' }, embedding: null })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('chat_archive');
    // The terminal stamp (an update with extract_skipped) is not written.
    expect(writtenJson()).not.toContain('extract_skipped');
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

  // Journal v3 J9: an app (not in the default allowlist) that carries a
  // published summary is indexed from it, with no model call and no
  // terminal skip; one indexed from that summary already is left alone.
  const published = (text: string) => ({
    ['published' + '_summary']: { text, source: 'author', hash: 'h', at: 'x', model: null },
  });

  it('indexes a type outside the allowlist from its published summary instead', async () => {
    h.selectQueue.push([node({ type: 'app', data: { ...published('A pump log.') } })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(h.writePublishedSummaryIndex).toHaveBeenCalledTimes(1);
    expect(disposition()).toBeUndefined();
    expect(writtenJson()).not.toContain('extract_skipped');
    expect(h.resolveChatKey).not.toHaveBeenCalled();
  });

  it('leaves an app indexed from its published summary already as it is', async () => {
    h.selectQueue.push([
      node({
        type: 'app',
        embedding: [0.3],
        data: { ...published('A pump log.'), summary: 'A pump log.' },
      }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(h.writePublishedSummaryIndex).not.toHaveBeenCalled();
    expect(disposition()).toBeUndefined();
  });

  it("asks for an app's summary in the allowlist branch, then indexes from what it wrote", async () => {
    const bare = node({ type: 'app' });
    h.selectQueue.push([bare]);
    h.summarizeAppForIndex.mockResolvedValueOnce({
      node: node({ type: 'app', data: { ...published('Made in the job.') } }),
      status: 'written',
    });
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(h.summarizeAppForIndex).toHaveBeenCalledTimes(1);
    expect(h.summarizeAppForIndex).toHaveBeenCalledWith(bare, 'o1');
    expect(h.writePublishedSummaryIndex).toHaveBeenCalledTimes(1);
    expect(disposition()).toBeUndefined();
  });

  it('a failed summarizer call is a terminal skip, never a throw', async () => {
    h.selectQueue.push([node({ type: 'app' })]);
    h.summarizeAppForIndex.mockImplementationOnce(async (n: unknown) => ({
      node: n,
      status: 'failed',
    }));
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('app_summary_failed');
    expect(writtenJson()).toContain('app_summary_failed');
    expect(h.writePublishedSummaryIndex).not.toHaveBeenCalled();
  });

  it('a type on the list never asks for an app summary', async () => {
    h.selectQueue.push([node({ type: 'note' })]);
    await admitForExtraction('n1', 'o1');
    expect(h.summarizeAppForIndex).not.toHaveBeenCalled();
  });

  it('still refuses an app with no published summary, as before', async () => {
    h.selectQueue.push([node({ type: 'app' })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('type_not_in_allowlist');
    expect(h.writePublishedSummaryIndex).not.toHaveBeenCalled();
  });

  // Terminal skips (`data.extract_skipped`): a verdict on the node itself is
  // stamped so the boot drain stops re-queuing it; a config or machinery
  // refusal is not, so the drain retries it once that is fixed.
  it('stamps a type outside the allowlist terminal', async () => {
    h.resolveExtractor.mockResolvedValue({ ...WORKER, params: { target_types: ['note'] } });
    h.selectQueue.push([node({ type: 'file' })]);
    await admitForExtraction('n1', 'o1');
    expect(writtenJson()).toContain('extract_skipped');
    expect(writtenJson()).toContain('type_not_in_allowlist');
  });

  it('stamps a conversation digest terminal', async () => {
    h.selectQueue.push([node({ type: 'note', tags: ['conversation-digest'] })]);
    await admitForExtraction('n1', 'o1');
    expect(writtenJson()).toContain('conversation_digest');
  });

  it('stamps a telegram turn with nothing to embed terminal, never one whose embed failed', async () => {
    h.selectQueue.push([node({ type: 'telegram_message', data: { text: '' } })]);
    await admitForExtraction('n1', 'o1');
    expect(writtenJson()).toContain('extract_skipped');

    h.updates.length = 0;
    h.embed.mockRejectedValueOnce(new Error('embedder down'));
    h.selectQueue.push([node({ type: 'telegram_message', data: { text: 'hello there' } })]);
    await admitForExtraction('n1', 'o1');
    expect(writtenJson()).not.toContain('extract_skipped');
  });

  it('never stamps a missing key: the drain must retry once it is set', async () => {
    h.resolveChatKey.mockResolvedValue({ ok: false, disposition: 'missing_api_key', detail: 'x' });
    h.selectQueue.push([node()]);
    await admitForExtraction('n1', 'o1');
    expect(writtenJson()).not.toContain('extract_skipped');
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

describe('admitForExtraction: a re-embed only (A10 #7)', () => {
  const kept = {
    summary: 'Pump overhaul notes.',
    extract_completed_at: '2026-01-01',
    index_work: 'embed',
  };

  it('re-embeds from the title and the kept summary, with no model and no key check', async () => {
    h.selectQueue.push([node({ title: 'Valve note', data: kept, embedding: null })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('embed_only');
    expect(h.embed).toHaveBeenCalledWith('o1', 'Valve note\n\nPump overhaul notes.');
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    expect(h.llmWorkAllowed).not.toHaveBeenCalled();
    expect(h.updates).toContainEqual(expect.objectContaining({ embedding: [0.1, 0.2] }));
  });

  it('re-embeds an item extracted before the completion marker existed (M1 scenario B)', async () => {
    const legacy = { summary: 'Pump overhaul notes.', index_work: 'embed' };
    h.selectQueue.push([node({ title: 'Valve note', data: legacy, embedding: null })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('embed_only');
    expect(h.embed).toHaveBeenCalledWith('o1', 'Valve note\n\nPump overhaul notes.');
    expect(h.resolveChatKey).not.toHaveBeenCalled();
  });

  it('embeds the title and the local text of an item with no summary the extractor skipped (M1 scenario A)', async () => {
    const skipped = {
      extract_skipped: { reason: 'body_too_short', at: '2026-01-01' },
      index_work: 'embed',
    };
    h.selectQueue.push([
      node({ type: 'page', title: 'Pump overhaul plan', data: skipped, embedding: null }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('embed_only');
    expect(h.embed).toHaveBeenCalledWith('o1', 'Pump overhaul plan\n\nthe body');
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    expect(h.llmWorkAllowed).not.toHaveBeenCalled();
  });

  it('embeds a file with no summary from its name spine, never re-parsing its bytes', async () => {
    const skipped = {
      extract_skipped: { reason: 'no_parser', at: '2026-01-01' },
      index_work: 'embed',
    };
    h.selectQueue.push([node({ type: 'file', title: 'tool.exe', data: skipped, embedding: null })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('embed_only');
    expect(h.embed).toHaveBeenCalledWith('o1', 'spine text');
    expect(h.readNodeBodyLocal).not.toHaveBeenCalled();
  });

  it('admits a table keeping its summary before the key pre-flight (L5)', async () => {
    // The model step reuses the summary: no model call, so no key. A
    // misconfigured cloud worker key must not leave the renamed table with
    // no vector.
    h.resolveChatKey.mockResolvedValue({ ok: false, disposition: 'missing_api_key', detail: 'x' });
    h.selectQueue.push([node({ type: 'table', data: kept, embedding: null })]);
    const res = await admitForExtraction('n1', 'o1');
    expect(res.proceed).toBe(true);
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    expect(h.llmWorkAllowed).toHaveBeenCalledTimes(1);
    expect(h.recordSkippedTrace).not.toHaveBeenCalled();
  });

  it('round 3 L1: a table keeping its summary that no assistant workspace reads is indexed locally, as on main', async () => {
    h.llmWorkAllowed.mockResolvedValue(false);
    h.selectQueue.push([node({ type: 'table', data: kept, embedding: null })]);
    const res = await admitForExtraction('n1', 'o1');
    expect(res.proceed).toBe(false);
    expect(disposition()).toBe('no_assistant_workspace');
    expect(h.writeRetrievalChunks).toHaveBeenCalledTimes(1);
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    // One guard read, not one per branch.
    expect(h.llmWorkAllowed).toHaveBeenCalledTimes(1);
    expect(writtenJson()).toContain('"indexing_applied":"local"');
    expect(writtenJson()).not.toContain('summary_model');
  });

  it('M3: an EMPTY summary is no summary: a rename embeds locally and the guard reads it the same way', async () => {
    // A model reply that was not JSON writes summary '' with the marker
    // (extractor-parse.ts). The local path's guard used to read the key's
    // presence as a summary, so nothing was written and the stamp stayed.
    const empty = { summary: '  ', extract_completed_at: '2026-01-01', index_work: 'embed' };
    h.selectQueue.push([node({ type: 'page', title: 'Pump plan', data: empty, embedding: null })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('embed_only');
    expect(h.embed).toHaveBeenCalledWith('o1', 'Pump plan\n\nthe body');
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    expect(h.llmWorkAllowed).not.toHaveBeenCalled();
    expect(h.updates).toContainEqual(expect.objectContaining({ embedding: [0.1, 0.2] }));
    // The write's guard is the shared predicate (btrim of the summary), not
    // the key's presence.
    expect(sqlValues(h.wheres.at(-1)).join(' ')).toContain('btrim(');
    expect(sqlValues(h.wheres.at(-1)).join(' ')).not.toContain("? 'summary'");
  });

  it('M3: a table with an empty summary, renamed, embeds locally too (no model step)', async () => {
    const empty = { summary: '', extract_completed_at: '2026-01-01', index_work: 'embed' };
    h.selectQueue.push([node({ type: 'table', title: 'Readings', data: empty, embedding: null })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('embed_only');
    expect(h.resolveChatKey).not.toHaveBeenCalled();
  });

  it('L4: an item that had a vector before the reset, with no summary, no marker and no skip: local, never a first pass', async () => {
    // A pre-marker item with an empty summary: on main a rename did nothing
    // (the sweep needs an empty vector). It must not run a model pass now.
    const hadVector = { summary: '', index_work: 'embed', index_work_had_vector: true };
    h.selectQueue.push([node({ title: 'Valve note', data: hadVector, embedding: null })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('embed_only');
    expect(h.embed).toHaveBeenCalledWith('o1', 'Valve note\n\nthe body');
    expect(h.resolveChatKey).not.toHaveBeenCalled();
  });

  it('embeds a table with no summary the extractor skipped, locally', async () => {
    const skipped = { extract_skipped: { reason: 'body_too_short', at: 'x' }, index_work: 'embed' };
    h.selectQueue.push([
      node({ type: 'table', title: 'Readings', data: skipped, embedding: null }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('embed_only');
    expect(h.resolveChatKey).not.toHaveBeenCalled();
  });

  it('runs the first pass of an item the extractor never saw, renamed before it ran', async () => {
    h.selectQueue.push([node({ data: { index_work: 'embed' }, embedding: null })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
    expect(h.embed).not.toHaveBeenCalled();
  });

  it('runs the whole pass when a content change waits (an extract stamp)', async () => {
    h.selectQueue.push([
      node({
        data: { extract_completed_at: '2026-01-01', index_work: 'extract' },
        embedding: null,
      }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
    expect(h.embed).not.toHaveBeenCalled();
  });

  it('round 3 M1: never skips an extract stamp as already extracted, whatever else the row holds', async () => {
    // Defence in depth: a summary, a vector and the marker with an 'extract'
    // stamp is a content change still waiting. The pass drops the stamp.
    h.selectQueue.push([
      node({
        data: { summary: 's', extract_completed_at: 'x', index_work: 'extract' },
        embedding: [0.5],
      }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
    expect(h.recordSkippedTrace).not.toHaveBeenCalled();
    // An 'embed' stamp on such a row is not a content change: skipped.
    h.selectQueue.push([
      node({
        data: { summary: 's', extract_completed_at: 'x', index_work: 'embed' },
        embedding: [0.5],
      }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(false);
    expect(disposition()).toBe('already_extracted');
  });

  it('runs the whole pass for a vectorless item with no stamp (as before A10 #7)', async () => {
    h.selectQueue.push([
      node({ data: { summary: 's', extract_completed_at: 'x' }, embedding: null }),
    ]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
    expect(h.embed).not.toHaveBeenCalled();
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

describe('admitForExtraction — the LLM-work cost guard (workspaces plan 5.3)', () => {
  it('no workspace with an assistant reads it: chunks and a vector locally, no model, no admission', async () => {
    h.llmWorkAllowed.mockResolvedValue(false);
    h.selectQueue.push([node()]);
    const r = await admitForExtraction('n1', 'o1');
    expect(r.proceed).toBe(false);
    expect(disposition()).toBe('no_assistant_workspace');
    expect(h.writeRetrievalChunks).toHaveBeenCalledTimes(1);
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    expect(writtenJson()).toContain('"indexing_applied":"local"');
  });

  it('an item an assistant workspace reads goes on to the model as before', async () => {
    h.selectQueue.push([node()]);
    const r = await admitForExtraction('n1', 'o1');
    expect(r.proceed).toBe(true);
    expect(h.writeRetrievalChunks).not.toHaveBeenCalled();
  });
});

describe('admitForExtraction — rows the clean-derived mark flagged (workspaces plan 5.3)', () => {
  it('a marked page or drawing not yet re-folded: indexed locally from its live text, stamped refolded, no model', async () => {
    for (const type of ['page', 'draw']) {
      vi.clearAllMocks();
      h.updates.length = 0;
      h.embed.mockResolvedValue([0.1, 0.2]);
      h.readNodeBodyLocal.mockResolvedValue('own words [embedded file]');
      h.resolveExtractor.mockResolvedValue({ ...WORKER, params: { target_types: ['*'] } });
      h.selectQueue.push([node({ type, derivedMixed: true, data: {} })]);
      const r = await admitForExtraction('n1', 'o1');
      expect(r.proceed).toBe(false);
      expect(disposition()).toBe('derived_mixed_unrefolded');
      // The live body (load-body folds it) is chunked and embedded locally.
      expect(h.readNodeBodyLocal).toHaveBeenCalledTimes(1);
      expect(h.writeRetrievalChunks).toHaveBeenCalledTimes(1);
      expect(h.writeRetrievalChunks.mock.calls[0]![2]).toBe('own words [embedded file]');
      expect(h.embed).toHaveBeenCalledTimes(1);
      // No side pass, no key check: no model.
      expect(h.autoTable).not.toHaveBeenCalled();
      expect(h.embeddedImages).not.toHaveBeenCalled();
      expect(h.resolveChatKey).not.toHaveBeenCalled();
      // The vector and the re-fold stamp in one write, then the terminal
      // stamp; the mark stays and no summary is written.
      const written = writtenJson();
      expect(written).toContain('"refolded":true');
      expect(written).toContain('extract_skipped');
      expect(written).not.toContain('summary');
      expect(written).not.toContain('derivedMixed');
    }
  });

  it('a marked page the re-fold rewrote goes on as before', async () => {
    h.resolveExtractor.mockResolvedValue({ ...WORKER, params: { target_types: ['*'] } });
    h.selectQueue.push([node({ type: 'page', derivedMixed: true, data: { refolded: true } })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
  });

  it('an unmarked page goes on as before', async () => {
    h.resolveExtractor.mockResolvedValue({ ...WORKER, params: { target_types: ['*'] } });
    h.selectQueue.push([node({ type: 'page', derivedMixed: false })]);
    expect((await admitForExtraction('n1', 'o1')).proceed).toBe(true);
  });
});
