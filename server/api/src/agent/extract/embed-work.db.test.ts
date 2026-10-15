/**
 * What a rename costs once the extractor has run (workspaces arch A10 #7,
 * fix round 1): the write goes through the real service, the extractor runs
 * through the real `extractNode`, and the model is a fake chat adapter that
 * counts its calls. A rename stamps `data.index_work = 'embed'`
 * (markContentChanged), and an embed stamp is never a model call:
 *
 *  - M1 scenario A: a page and a drawing the extractor skipped as too short
 *    (no summary), and a table indexed with no summary (the cost guard's
 *    local index), renamed to a long title: embedded from the title and the
 *    local text, 0 model calls;
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
 * Fix round 2:
 *
 *  - M3: an EMPTY summary is no summary: an item with `summary: ''` and the
 *    marker (a model reply that was not JSON), renamed, gets its vector
 *    locally and the stamp is dropped (0 calls); a table commit that keeps
 *    the shape on a table with an empty summary runs the whole pass, as on
 *    main (1 call);
 *  - L4: an item that had a vector before the rename, with no summary, no
 *    marker and no skip stamp, re-embeds locally (0 calls; main did nothing);
 *  - L5: a table keeping its summary, renamed while the worker's key is
 *    missing, still gets its vector (0 calls, no key needed);
 *  - L6: a terminal skip drops only the stamp its job saw: a content
 *    change's 'extract' stamp that landed meanwhile survives.
 *
 * Fix round 3:
 *
 *  - M1: a content change that commits while the body loads (after
 *    admission, before the row version is read) sets an 'extract' stamp the
 *    job's guarded write now drops (it reads the stamp with the version), so
 *    the edit's own job skips as on main and a later rename costs 0 calls;
 *    an 'extract' stamp on a row that looks extracted runs one pass, never a
 *    loop;
 *  - L1: a table keeping its summary that no assistant workspace reads is
 *    indexed locally, as on main (no summary_model rewrite, 0 calls).
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
  /** The worker's key resolves (false: a misconfigured cloud key, L5). */
  keyOk: true,
  /** Runs once, after the next body load (the round 3 M1 race). */
  afterLoad: null as null | (() => Promise<void>),
  /** The LLM-work cost guard passes (false: round 3 L1). */
  llmAllowed: true,
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
  return {
    ...actual,
    resolveChatKey: async () =>
      h.keyOk
        ? { ok: true }
        : { ok: false, disposition: 'missing_api_key', detail: 'no key (test)' },
  };
});
// Every brain item passes the LLM-work cost guard (llm-guard.ts) once a
// workspace with an assistant reads it; this scratch brain has no assistant.
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return { ...actual, llmWorkAllowed: async () => h.llmAllowed };
});
// The body load, then the hook: a write that commits after admission read
// the row and before the extractor reads its version.
vi.mock('./load-body', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./load-body')>();
  return {
    ...actual,
    loadExtractableBody: async (...args: Parameters<typeof actual.loadExtractableBody>) => {
      const res = await actual.loadExtractableBody(...args);
      const hook = h.afterLoad;
      h.afterLoad = null;
      if (hook) await hook();
      return res;
    },
  };
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
  let stampExtractSkipped: typeof import('./terminal').stampExtractSkipped;
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
  /** Make `id` look extracted: a summary, a vector, and (unless legacy) the
   *  marker; the work stamp done. */
  const indexed = async (id: string, opts: { marker: boolean }) => {
    const v = `[${vectorOf(`indexed ${id}`).join(',')}]`;
    await x(sql`update nodes set embedding = ${v}::vector,
        data = (coalesce(data, '{}'::jsonb) - 'index_work' - 'index_work_had_vector') || jsonb_build_object(
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
    ({ stampExtractSkipped } = await import('./terminal'));
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`a10ew-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    h.modelCalls = 0;
    h.duringEmbed = null;
    h.keyOk = true;
    h.afterLoad = null;
    h.llmAllowed = true;
  });

  const LONG = 'Pump overhaul plan for the north site';

  it('scenario A: a page skipped as too short, renamed to a long title: embedded locally, 0 model calls', async () => {
    const page = await c.createPage(owner, { title: 'Untitled page' });
    await extractNode(page.id, owner);
    expect(await lastDisposition(page.id)).toBe('body_too_short');
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

  it('a table indexed with no summary (the cost guard local index), renamed: embedded locally, 0 model calls', async () => {
    const table = await c.createTable(owner, { title: 'Untitled table' });
    const v = `[${vectorOf(`local ${table.id}`).join(',')}]`;
    await x(sql`update nodes set embedding = ${v}::vector,
        data = data || jsonb_build_object('indexing_applied', 'local',
                                          'extract_completed_at', now()::text)
      where id = ${table.id}`);

    await c.updateTable(owner, table.id, { title: LONG });
    expect((await row(table.id)).work).toBe('embed');
    await extractNode(table.id, owner);

    const r = await row(table.id);
    expect(h.modelCalls).toBe(0);
    expect(await lastDisposition(table.id)).toBe('embed_only');
    expect(textOf(r.vec)?.startsWith(LONG)).toBe(true);
    expect(r.summary).toBeNull();
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

  /** Give `id` a vector and `data`, as a pass long ago left it (its work
   *  stamp done). */
  const seeded = async (id: string, data: Record<string, unknown>) => {
    const v = `[${vectorOf(`seeded ${id}`).join(',')}]`;
    await x(sql`update nodes set embedding = ${v}::vector,
        data = (coalesce(data, '{}'::jsonb) - 'index_work' - 'index_work_had_vector')
          || ${JSON.stringify(data)}::jsonb
      where id = ${id}`);
  };

  it('M3: an item with an empty summary and the marker, renamed: embedded locally, stamp dropped, 0 model calls', async () => {
    const note = await c.createNote(owner, { title: 'Pump note', content: 'Pump check due.' });
    await seeded(note.id, { summary: '', extract_completed_at: '2026-01-01T00:00:00Z' });
    await c.updateNote(owner, note.id, { title: 'Valve note' });
    expect((await row(note.id)).work).toBe('embed');
    await extractNode(note.id, owner);

    const r = await row(note.id);
    expect(h.modelCalls).toBe(0);
    expect(await lastDisposition(note.id)).toBe('embed_only');
    expect(textOf(r.vec)).toBe('Valve note\n\nPump check due.');
    expect(r.summary).toBe('');
    // The stamp is gone, so the boot drain has nothing to re-run.
    expect(r.work).toBeNull();
  });

  it('M3: a cell-only table commit on a table with an empty summary runs the whole pass, as on main (1 model call)', async () => {
    const t = await c.createTable(owner, { title: 'Readings' });
    const col = t.data.columns[0]!.id;
    await c.commitTable(owner, t.id, {
      ...t.data,
      rows: [{ id: randomUUID(), cells: { [col]: 'a' } }],
    });
    await seeded(t.id, { summary: '', extract_completed_at: '2026-01-01T00:00:00Z' });
    await c.commitTable(owner, t.id, {
      ...t.data,
      rows: [{ id: randomUUID(), cells: { [col]: 'b' } }],
    });
    expect((await row(t.id)).work).toBe('extract');
    expect((await row(t.id)).vec).toBeNull();
    await extractNode(t.id, owner);

    const r = await row(t.id);
    expect(h.modelCalls).toBe(1);
    expect(r.summary).toBe('A summary the model wrote.');
    expect(r.vec).not.toBeNull();
    expect(r.work).toBeNull();
  });

  it('a cell-only table commit on a summarised table reuses the summary (0 model calls)', async () => {
    const t = await c.createTable(owner, { title: 'Levels' });
    const col = t.data.columns[0]!.id;
    await c.commitTable(owner, t.id, {
      ...t.data,
      rows: [{ id: randomUUID(), cells: { [col]: 'a' } }],
    });
    await indexed(t.id, { marker: true });
    await c.commitTable(owner, t.id, {
      ...t.data,
      rows: [{ id: randomUUID(), cells: { [col]: 'b' } }],
    });
    expect((await row(t.id)).work).toBe('embed');
    await extractNode(t.id, owner);

    const r = await row(t.id);
    expect(h.modelCalls).toBe(0);
    expect(r.summary).toBe('Pump overhaul notes.');
    expect(r.vec).not.toBeNull();
    expect(r.work).toBeNull();
  });

  it('L4: an item that had a vector, with an empty summary, no marker and no skip, renamed: local, 0 model calls', async () => {
    const note = await c.createNote(owner, { title: 'Old note', content: 'Seal kit ordered.' });
    await seeded(note.id, { summary: '' });
    await c.updateNote(owner, note.id, { title: 'Seal note' });
    // A second rename before the extractor ran still knows the row had a vector.
    await c.updateNote(owner, note.id, { title: 'Seal kit note' });
    const [stamp] = await x<{ had: boolean | null }>(
      sql`select (data->>'index_work_had_vector')::boolean as had from nodes where id = ${note.id}`,
    );
    expect(stamp?.had).toBe(true);
    await extractNode(note.id, owner);

    const r = await row(note.id);
    expect(h.modelCalls).toBe(0);
    expect(await lastDisposition(note.id)).toBe('embed_only');
    expect(textOf(r.vec)).toBe('Seal kit note\n\nSeal kit ordered.');
    expect(r.work).toBeNull();
    const [after] = await x<{ had: string | null }>(
      sql`select data->>'index_work_had_vector' as had from nodes where id = ${note.id}`,
    );
    expect(after?.had).toBeNull();
  });

  it('L4 control: an item never indexed, renamed before its first pass, still runs that pass (1 model call)', async () => {
    const note = await c.createNote(owner, {
      title: 'Fresh note',
      content: 'The north pump needs a new seal before winter starts.',
    });
    await x(sql`update nodes set embedding = null where id = ${note.id}`);
    await c.updateNote(owner, note.id, { title: 'Fresh pump note' });
    const [stamp] = await x<{ had: string | null }>(
      sql`select data->>'index_work_had_vector' as had from nodes where id = ${note.id}`,
    );
    expect(stamp?.had).toBeNull();
    await extractNode(note.id, owner);
    expect(h.modelCalls).toBe(1);
  });

  it('L5: a table keeping its summary, renamed while the worker key is missing: vector rebuilt, 0 model calls', async () => {
    h.keyOk = false;
    const table = await c.createTable(owner, { title: 'Flows' });
    await indexed(table.id, { marker: true });
    await c.updateTable(owner, table.id, { title: 'Flows by month' });
    await extractNode(table.id, owner);

    const r = await row(table.id);
    expect(h.modelCalls).toBe(0);
    expect(r.vec).not.toBeNull();
    expect(textOf(r.vec)).toBe('Flows by month\n\nPump overhaul notes.');
    expect(r.summary).toBe('Pump overhaul notes.');
    expect(r.work).toBeNull();
  });

  it('L6: a terminal skip drops only the stamp its job saw; a newer extract stamp survives', async () => {
    const page = await c.createPage(owner, { title: 'Race page' });
    // The job loaded the row with no stamp; a content change landed meanwhile.
    await x(
      sql`update nodes set data = data || '{"index_work":"extract"}'::jsonb where id = ${page.id}`,
    );
    await stampExtractSkipped(page.id, 'body_too_short', null);
    let r = await row(page.id);
    expect(r.skipped).toBe('body_too_short');
    expect(r.work).toBe('extract');
    // The job that saw the extract stamp answers it: dropped.
    await stampExtractSkipped(page.id, 'body_too_short', 'extract');
    r = await row(page.id);
    expect(r.work).toBeNull();
  });
  it('round 3 M1: a content change during the body load: its stamp is dropped by the guarded write, the edit job skips as on main, a later rename costs 0 model calls', async () => {
    const note = await c.createNote(owner, {
      title: 'Seal note',
      content: 'The north pump needs a new seal before winter starts.',
    });
    // Admitted with no stamp and no vector: a first pass.
    await x(sql`update nodes set embedding = null,
        data = data - 'index_work' - 'index_work_had_vector' where id = ${note.id}`);
    expect((await row(note.id)).work).toBeNull();
    // The edit commits after admission read the row, before the version read.
    h.afterLoad = async () => {
      await c.updateNote(owner, note.id, {
        content: 'The north pump seal was replaced in October and passed its test.',
      });
      expect((await row(note.id)).work).toBe('extract');
    };
    await extractNode(note.id, owner);
    let r = await row(note.id);
    expect(h.modelCalls).toBe(1);
    expect(r.summary).toBe('A summary the model wrote.');
    expect(r.vec).not.toBeNull();
    // Before round 3 the 'extract' stamp stayed here for good.
    expect(r.work).toBeNull();

    // The edit's own job: already extracted, as on main (no second call).
    await extractNode(note.id, owner);
    expect(h.modelCalls).toBe(1);
    expect(await lastDisposition(note.id)).toBe('already_extracted');

    // A later rename: an embed stamp, re-embedded from the kept summary.
    await c.updateNote(owner, note.id, { title: 'Seal replaced' });
    expect((await row(note.id)).work).toBe('embed');
    await extractNode(note.id, owner);
    r = await row(note.id);
    expect(h.modelCalls).toBe(1);
    expect(await lastDisposition(note.id)).toBe('embed_only');
    expect(textOf(r.vec)).toBe('Seal replaced\n\nA summary the model wrote.');
    expect(r.work).toBeNull();
  });

  it('round 3 M1: an extract stamp on a row that looks extracted runs one pass, then skips (no loop)', async () => {
    const note = await c.createNote(owner, {
      title: 'Stuck note',
      content: 'The east pump gasket swap is due before the spring shutdown.',
    });
    await indexed(note.id, { marker: true });
    await x(sql`update nodes set data = data || '{"index_work":"extract"}'::jsonb
      where id = ${note.id}`);
    await extractNode(note.id, owner);
    expect(h.modelCalls).toBe(1);
    expect((await row(note.id)).work).toBeNull();
    await extractNode(note.id, owner);
    await extractNode(note.id, owner);
    expect(h.modelCalls).toBe(1);
    expect(await lastDisposition(note.id)).toBe('already_extracted');
  });

  it('round 3 L1: a table keeping its summary that no assistant workspace reads is indexed locally, as on main (0 model calls)', async () => {
    h.llmAllowed = false;
    const table = await c.createTable(owner, { title: 'Pressures' });
    await indexed(table.id, { marker: true });
    await c.updateTable(owner, table.id, { title: 'Pressures by week' });
    expect((await row(table.id)).work).toBe('embed');
    await extractNode(table.id, owner);

    const r = await row(table.id);
    expect(h.modelCalls).toBe(0);
    expect(await lastDisposition(table.id)).toBe('no_assistant_workspace');
    expect(r.vec).not.toBeNull();
    expect(r.summary).toBe('Pump overhaul notes.');
    expect(r.work).toBeNull();
    const [d] = await x<{ applied: string | null; model: string | null }>(sql`
      select data->>'indexing_applied' as applied, data->>'summary_model' as model
        from nodes where id = ${table.id}`);
    expect(d?.applied).toBe('local');
    expect(d?.model).toBe('m');
  });
});
