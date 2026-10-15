/**
 * What a rename costs once the extractor has run (workspaces arch A10 #7,
 * fix round 1): the write goes through the real service, the extractor runs
 * through the real `extractNode`, and the model is a fake chat adapter that
 * counts its calls. A rename stamps `data.index_work = 'embed'`
 * (markContentChanged), and an embed stamp is never a model call:
 *
 *  - M1 scenario A: a page, a drawing and a table the extractor skipped as
 *    too short (no summary), renamed to a long title: embedded from the
 *    title and the local text, 0 model calls;
 *  - M1 scenario B: an item extracted before the completion marker existed
 *    (a summary, no marker), renamed: re-embedded from its summary, 0 calls;
 *  - a table keeping its summary, renamed: the model step reuses the
 *    summary, 0 calls;
 *  - the control: a content change still waiting when the rename lands keeps
 *    its 'extract' stamp, and the pass runs (1 call), so the counter counts;
 *  - M2: renaming a chat archive or a conversation digest keeps its vector;
 *    one with no vector gets it back from its topic and summary, 0 calls;
 *  - L1: a job for an older title never writes its vector over a newer
 *    rename's reset; the newer job writes its own.
 *
 * The embedder is a stub that gives each distinct text its own vector, so
 * the test can tell which text a stored vector came from. A migrated scratch
 * database, dropped after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/embed-work.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIM = 768;

const h = vi.hoisted(() => ({
  texts: [] as string[],
  modelCalls: 0,
  /** Runs inside the next embed call, once (the L1 race). */
  duringEmbed: null as null | (() => Promise<void>),
}));

/** One vector per distinct text: a one-hot at the text's first-seen index. */
function vectorOf(text: string): number[] {
  let i = h.texts.indexOf(text);
  if (i < 0) i = h.texts.push(text) - 1;
  return Array.from({ length: DIM }, (_, k) => (k === (i % (DIM - 1)) + 1 ? 1 : 0));
}

vi.mock('@mantle/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/embeddings')>();
  return {
    ...actual,
    embed: async (_o: string, text: string) => {
      const hook = h.duringEmbed;
      h.duringEmbed = null;
      if (hook) await hook();
      return vectorOf(text);
    },
    embedBatch: async (_o: string, texts: string[]) => texts.map(vectorOf),
    chunkWindowsEnabled: async () => false,
  };
});
// The model: a fake chat adapter that counts its calls.
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async () => {
    h.modelCalls += 1;
    return {
      text: JSON.stringify({
        summary: 'A summary the model wrote.',
        entities: [],
        facts: [],
        relations: [],
      }),
      model: 'fake/extractor',
    };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'local', adapterName: 'fake-chat', chat })),
  };
});
vi.mock('./model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./model')>();
  return {
    ...actual,
    resolveExtractor: async () => ({
      id: '00000000-0000-4000-8000-0000000000e1',
      slug: 'extractor',
      provider: 'local',
      model: 'fake/extractor',
      apiKeyId: null,
      systemPrompt: null,
      params: { target_types: ['*'], extract_facts: false },
    }),
  };
});
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return { ...actual, resolveChatKey: async () => ({ ok: true }) };
});
vi.mock('./auto-table', () => ({ maybeAutoTableSpreadsheet: async () => undefined }));
vi.mock('./images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./images')>();
  return { ...actual, maybeExtractEmbeddedImages: async () => undefined };
});

describe.skipIf(!URL)('an embed stamp is never a model call (A10 #7 fix round 1)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let extractNode: typeof import('../extractor').extractNode;
  let dir = '';
  const owner = randomUUID();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  type Row = {
    vec: string | null;
    summary: string | null;
    work: string | null;
    skipped: string | null;
    title: string;
  };
  const row = async (id: string): Promise<Row> => {
    const [r] = await x<Row>(sql`
      select embedding::text as vec, data->>'summary' as summary, data->>'index_work' as work,
             data->'extract_skipped'->>'reason' as skipped, title
        from nodes where id = ${id}`);
    return r!;
  };
  /** The text a stored vector was made from (the stub's one-hot index). */
  const textOf = (vec: string | null): string | null => {
    if (!vec) return null;
    const at = (JSON.parse(vec) as number[]).indexOf(1);
    return at > 0 ? (h.texts[at - 1] ?? null) : null;
  };
  /** The disposition of the last extractor trace on `id`. */
  const lastDisposition = async (id: string): Promise<string | null> => {
    const [t] = await x<{ d: string | null }>(sql`
      select coalesce(data->>'disposition', status::text) as d from traces
       where subject_id = ${id} and kind = 'extractor_run'
       order by started_at desc, created_at desc limit 1`);
    return t?.d ?? null;
  };
  /** Make `id` look extracted: a summary, a vector, and (unless legacy) the marker. */
  const indexed = async (id: string, opts: { marker: boolean }) => {
    const v = `[${vectorOf(`indexed ${id}`).join(',')}]`;
    await x(sql`update nodes set embedding = ${v}::vector,
        data = coalesce(data, '{}'::jsonb) || jsonb_build_object(
          'summary', 'Pump overhaul notes.', 'summary_model', 'm', 'summary_at', now()::text)
          || case when ${opts.marker} then jsonb_build_object('extract_completed_at', now()::text)
                  else '{}'::jsonb end
      where id = ${id}`);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a10-embed-work-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    ({ extractNode } = await import('../extractor'));
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`a10ew-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    h.modelCalls = 0;
    h.duringEmbed = null;
  });

  const LONG = 'Pump overhaul plan for the north site';

  it('scenario A: a page skipped as too short, renamed to a long title: embedded locally, 0 model calls', async () => {
    const page = await c.createPage(owner, { title: 'Untitled page' });
    await extractNode(page.id, owner);
    expect((await row(page.id)).skipped).toBe('body_too_short');

    await c.updatePage(owner, page.id, { title: LONG });
    expect((await row(page.id)).work).toBe('embed');
    await extractNode(page.id, owner);

    const r = await row(page.id);
    expect(h.modelCalls).toBe(0);
    expect(await lastDisposition(page.id)).toBe('embed_only');
    expect(textOf(r.vec)).toBe(LONG);
    expect(r.summary).toBeNull();
    expect(r.work).toBeNull();
  });

  it('scenario A: a drawing skipped as too short, renamed: embedded locally, 0 model calls', async () => {
    const draw = await c.createDraw(owner, { title: 'Untitled drawing' });
    await extractNode(draw.id, owner);
    expect((await row(draw.id)).skipped).toBe('body_too_short');

    await c.updateDraw(owner, draw.id, { title: LONG });
    await extractNode(draw.id, owner);

    const r = await row(draw.id);
    expect(h.modelCalls).toBe(0);
    expect(textOf(r.vec)).toBe(LONG);
    expect(r.work).toBeNull();
  });

  it('scenario A: a table skipped as too short, renamed: embedded locally, 0 model calls', async () => {
    const table = await c.createTable(owner, { title: 'Untitled table' });
    await extractNode(table.id, owner);
    expect((await row(table.id)).skipped).toBe('body_too_short');

    await c.updateTable(owner, table.id, { title: LONG });
    await extractNode(table.id, owner);

    const r = await row(table.id);
    expect(h.modelCalls).toBe(0);
    expect(r.vec).not.toBeNull();
    expect(textOf(r.vec)?.startsWith(LONG)).toBe(true);
    expect(r.work).toBeNull();
  });

  it('a table keeping its summary, renamed: the model step reuses it, 0 model calls', async () => {
    const table = await c.createTable(owner, { title: 'Readings' });
    await indexed(table.id, { marker: true });
    await c.updateTable(owner, table.id, { title: 'Levels by month' });
    await extractNode(table.id, owner);

    const r = await row(table.id);
    expect(h.modelCalls).toBe(0);
    expect(r.vec).not.toBeNull();
    expect(r.summary).toBe('Pump overhaul notes.');
    expect(r.work).toBeNull();
  });

  it('scenario B: an item extracted before the completion marker, renamed: from its summary, 0 model calls', async () => {
    const note = await c.createNote(owner, { title: 'Pump note', content: 'Pump check.' });
    await indexed(note.id, { marker: false });
    await c.updateNote(owner, note.id, { title: 'Valve note' });
    await extractNode(note.id, owner);

    const r = await row(note.id);
    expect(h.modelCalls).toBe(0);
    expect(await lastDisposition(note.id)).toBe('embed_only');
    expect(textOf(r.vec)).toBe('Valve note\n\nPump overhaul notes.');
    expect(r.summary).toBe('Pump overhaul notes.');
  });

  it('control: a rename while a content change waits keeps the extract stamp, and the pass runs (1 model call)', async () => {
    const page = await c.createPage(owner, { title: 'Pump page' });
    await indexed(page.id, { marker: true });
    await c.commitPage(owner, page.id, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'The north pump needs a new seal before winter.' }],
        },
      ],
    });
    await c.updatePage(owner, page.id, { title: 'Valve page' });
    expect((await row(page.id)).work).toBe('extract');
    await extractNode(page.id, owner);

    const r = await row(page.id);
    expect(h.modelCalls).toBe(1);
    expect(r.summary).toBe('A summary the model wrote.');
    expect(r.vec).not.toBeNull();
    expect(r.work).toBeNull();
  });

  it.each([
    ['a chat archive', { kind: 'chat_archive' }, [] as string[]],
    ['a conversation digest', { kind: 'conversation_digest' }, ['conversation-digest']],
  ])('M2: renaming %s keeps its vector', async (_label, kind, tags) => {
    const note = await c.createNote(owner, { title: 'Pumps', content: '', tags });
    const v = `[${vectorOf(`digest ${note.id}`).join(',')}]`;
    await x(sql`update nodes set embedding = ${v}::vector,
        data = data || ${JSON.stringify({ ...kind, topic: 'Pumps', summary: 'We talked pumps.' })}::jsonb
      where id = ${note.id}`);
    await c.updateNote(owner, note.id, { title: 'Pump talk' });

    const r = await row(note.id);
    expect(r.title).toBe('Pump talk');
    expect(textOf(r.vec)).toBe(`digest ${note.id}`);
    expect(r.work).toBeNull();
  });

  it.each([
    ['a chat archive', { kind: 'chat_archive' }, [] as string[]],
    ['a conversation digest', { kind: 'conversation_digest' }, ['conversation-digest']],
  ])(
    'M2: %s with no vector gets it back from its topic and summary, 0 model calls',
    async (_label, kind, tags) => {
      const note = await c.createNote(owner, { title: 'Pump talk', content: '', tags });
      await x(sql`update nodes set embedding = null,
        data = data || ${JSON.stringify({ ...kind, topic: 'Pumps', summary: 'We talked pumps.' })}::jsonb
      where id = ${note.id}`);
      await extractNode(note.id, owner);

      const r = await row(note.id);
      expect(h.modelCalls).toBe(0);
      expect(textOf(r.vec)).toBe('Pumps\nWe talked pumps.');
      expect(r.summary).toBe('We talked pumps.');
    },
  );

  it('L1: a job for an older title does not write over a newer rename; the newer job writes its own', async () => {
    const note = await c.createNote(owner, { title: 'Pump note', content: 'Pump check.' });
    await indexed(note.id, { marker: true });
    await c.updateNote(owner, note.id, { title: 'First title' });
    // The first job read "First title"; while it embeds, the user renames again.
    h.duringEmbed = async () => {
      await c.updateNote(owner, note.id, { title: 'Second title' });
    };
    await extractNode(note.id, owner);
    let r = await row(note.id);
    expect(r.vec).toBeNull();
    expect(r.work).toBe('embed');

    await extractNode(note.id, owner);
    r = await row(note.id);
    expect(h.modelCalls).toBe(0);
    expect(textOf(r.vec)).toBe('Second title\n\nPump overhaul notes.');
    expect(r.work).toBeNull();
  });
});
