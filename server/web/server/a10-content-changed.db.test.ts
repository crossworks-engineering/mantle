/**
 * What a write re-indexes, on a real database (workspaces arch A10 #7;
 * docs/content.md, "Re-index after a write"). Record, move, compare: every
 * cell below was recorded on main (a10-content-changed.main.json) while each
 * write path still reset the index by hand; each cell the step changed is
 * named in a10-content-changed.changes.json with its new answer and the
 * reason. A cell that differs from main and is not named there fails, and so
 * does a named change that no longer happens.
 *
 * Each cell takes a fresh item of one kind, indexed (a summary, its model
 * and entities, the completion marker and a vector), runs ONE write path
 * through the real service function, and reads what the write left:
 *
 *   none      nothing reset, nothing announced to the extractor
 *   embed     the vector cleared, the summary kept, announced: the
 *             extractor re-embeds from the title and the summary it keeps
 *             (no model call)
 *   extract   the vector and the summary cleared, announced: a full pass
 *             (one model call: summary, facts, entities)
 *   rerun     the completion marker cleared, the vector kept, announced
 *   gone      the row was deleted (nothing announced)
 *
 * A create is recorded as what the insert left (the INSERT trigger announces
 * it). No model and no embedder run: the extractor is not running, only its
 * channel is listened to. The logins are rows of a scratch database.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a10-content-changed.db.test.ts
 *   A10_REINDEX_RECORD=main …   writes a10-content-changed.main.json (on main only)
 *   A10_REINDEX_RECORD=now …    writes a10-content-changed.now.json (to name changes)
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;
/** `main`: write the main file (on main only); `now`: write what this tree
 *  answers beside it, to name the changes from (never checked in). */
const RECORD = process.env.A10_REINDEX_RECORD;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_FILE = path.join(HERE, 'a10-content-changed.main.json');
const CHANGES_FILE = path.join(HERE, 'a10-content-changed.changes.json');

type Changes = {
  reasons: Record<string, string>;
  cells: Record<string, { now: string; why: string }>;
};

const SPEC = {
  id: 'f1',
  name: 'Flow',
  variables: [{ symbol: 'a', name: 'A', role: 'input' }],
  expressions: [{ id: 'e1', resultSymbol: 'r', expression: '{a} * 2' }],
};
const SPEC2 = { ...SPEC, expressions: [{ id: 'e1', resultSymbol: 'r', expression: '{a} * 3' }] };
const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pump overhaul.' }] }],
};
const DOC2 = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Valve overhaul.' }] }],
};

describe.skipIf(!DB_URL)('what a write re-indexes (A10 #7): the recorded matrix', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ts: Ts;
  let c: typeof import('../../../packages/content/src/notes') &
    typeof import('../../../packages/content/src/tasks') &
    typeof import('../../../packages/content/src/events') &
    typeof import('../../../packages/content/src/journal') &
    typeof import('../../../packages/content/src/formulas') &
    typeof import('../../../packages/content/src/contacts') &
    typeof import('../../../packages/content/src/locations') &
    typeof import('../../../packages/content/src/draws') &
    typeof import('../../../packages/content/src/pages') &
    typeof import('../../../packages/content/src/tables') &
    typeof import('../../../packages/content/src/tree/node-ops');
  let f: typeof import('@mantle/files');
  let secrets: typeof import('@/lib/secrets');
  let dir = '';
  const owner = randomUUID();
  const announced: string[] = [];
  let unlisten: () => Promise<void> = async () => {};
  const cells: Record<string, string> = {};

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const client = () =>
    (m.systemDb as unknown as { $client: Parameters<Ts['notifyBarrier']>[0] }).$client;
  const barrier = () =>
    ts.notifyBarrier(client(), 'node_ingested', { seen: (p) => announced.includes(p) });

  /** A row of `type` with `data`, as the services' own creates leave it. */
  const insert = async (type: string, title: string, root: string, data: object) => {
    const id = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path, data)
      values (${id}, ${owner}, ${type}::node_type, ${title}, ${root}::ltree,
              ${JSON.stringify(data)}::jsonb)`);
    return id;
  };

  /** Make `id` look indexed, then forget what was announced so far. */
  const indexed = async (id: string) => {
    await x(sql`update nodes set
        embedding = array_fill(0.01::real, array[768])::vector,
        data = coalesce(data, '{}'::jsonb) || jsonb_build_object(
          'summary', 'A summary.', 'summary_model', 'm', 'summary_at', now()::text,
          'entities', jsonb_build_array('Pump'), 'extract_completed_at', now()::text,
          'indexing_applied', 'full')
      where id = ${id}`);
    await barrier();
    announced.length = 0;
  };

  /** What the write left on `id`. */
  const observe = async (id: string): Promise<string> => {
    await barrier();
    const told = announced.includes(id);
    const [r] = await x<{ vec: boolean; summary: boolean; marker: boolean }>(sql`
      select embedding is null as vec, data ? 'summary' as summary,
             data ? 'extract_completed_at' as marker
        from nodes where id = ${id}`);
    if (!r) return told ? 'gone+announced' : 'gone';
    if (!told && !r.vec && r.summary && r.marker) return 'none';
    if (told && r.vec && !r.summary) return 'extract';
    if (told && r.vec && r.summary) return 'embed';
    if (told && !r.vec && !r.marker) return 'rerun';
    return `odd(announced=${told},vectorCleared=${r.vec},summary=${r.summary},marker=${r.marker})`;
  };

  /** One cell: a fresh indexed item, one write, what it left. */
  const cell = async (
    key: string,
    make: () => Promise<string>,
    write: (id: string) => Promise<unknown>,
  ) => {
    const id = await make();
    await indexed(id);
    await write(id);
    cells[key] = await observe(id);
  };

  /** One create cell: what the create's insert left. */
  const created = async (key: string, create: () => Promise<string>) => {
    await barrier();
    announced.length = 0;
    const id = await create();
    await barrier();
    const told = announced.includes(id);
    const [r] = await x<{ vec: boolean }>(
      sql`select embedding is null as vec from nodes where id = ${id}`,
    );
    cells[key] = told && r?.vec ? 'insert' : `odd(create announced=${told})`;
  };

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    dir = await mkdtemp(path.join(tmpdir(), 'a10cc-'));
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    c = Object.assign(
      {},
      ...(await Promise.all([
        import('../../../packages/content/src/notes'),
        import('../../../packages/content/src/tasks'),
        import('../../../packages/content/src/events'),
        import('../../../packages/content/src/journal'),
        import('../../../packages/content/src/formulas'),
        import('../../../packages/content/src/contacts'),
        import('../../../packages/content/src/locations'),
        import('../../../packages/content/src/draws'),
        import('../../../packages/content/src/pages'),
        import('../../../packages/content/src/tables'),
        import('../../../packages/content/src/tree/node-ops'),
      ])),
    ) as typeof c;
    f = await import('@mantle/files');
    secrets = await import('@/lib/secrets');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`a10cc-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const sub = await client().listen('node_ingested', (p: string) => announced.push(p));
    unlisten = () => sub.unlisten();
  }, 180_000);

  afterAll(async () => {
    await unlisten();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('records every write path of every kind that has one', async () => {
    // ── note ──
    const note = () => insert('note', 'Pump note', 'notes', { content: 'Pump check.' });
    await created(
      'note|create',
      async () => (await c.createNote(owner, { title: 'N', content: 'x' })).id,
    );
    await cell('note|rename', note, (id) => c.updateNote(owner, id, { title: 'Valve note' }));
    await cell('note|edit:content', note, (id) =>
      c.updateNote(owner, id, { content: 'Valve check.' }),
    );
    await cell('note|edit:content-same', note, (id) =>
      c.updateNote(owner, id, { content: 'Pump check.' }),
    );
    await cell('note|tags', note, (id) => c.updateNote(owner, id, { tags: ['plant'] }));
    await cell('note|move', note, async (id) => {
      await c.createNodeFolder(owner, 'notes', 'Sub');
      await c.moveNodeItem(owner, 'notes', id, 'notes.sub');
    });
    await cell('note|delete', note, (id) => c.deleteNote(owner, id));

    // ── task ──
    const task = () => insert('task', 'Fix pump', 'tasks', { body: 'Seal leaks.', status: 'open' });
    await created('task|create', async () => (await c.createTask(owner, { title: 'T' })).id);
    await cell('task|rename', task, (id) => c.updateTask(owner, id, { title: 'Fix valve' }));
    await cell('task|edit:body', task, (id) => c.updateTask(owner, id, { body: 'Seal all.' }));
    await cell('task|edit:status', task, (id) => c.updateTask(owner, id, { status: 'done' }));
    await cell('task|edit:status-same', task, (id) => c.updateTask(owner, id, { status: 'open' }));
    await cell('task|edit:rank', task, (id) => c.updateTask(owner, id, { rank: 'a0' }));
    await cell('task|tags', task, (id) => c.updateTask(owner, id, { tags: ['plant'] }));
    await cell('task|delete', task, (id) => c.deleteTask(owner, id));

    // ── event ──
    const startsAt = '2026-11-01T09:00:00.000Z';
    const event = () =>
      insert('event', 'Pump review', 'events', {
        starts_at: startsAt,
        body: 'Agenda.',
        remind_minutes_before: 0,
        remind_at: startsAt,
      });
    await created(
      'event|create',
      async () => (await c.createEvent(owner, { title: 'E', startsAt })).id,
    );
    await cell('event|rename', event, (id) => c.updateEvent(owner, id, { title: 'Valve review' }));
    await cell('event|rename-same', event, (id) =>
      c.updateEvent(owner, id, { title: 'Pump review' }),
    );
    await cell('event|edit:body', event, (id) => c.updateEvent(owner, id, { body: 'Minutes.' }));
    await cell('event|edit:location', event, (id) =>
      c.updateEvent(owner, id, { location: 'Plant 2' }),
    );
    await cell('event|tags', event, (id) => c.updateEvent(owner, id, { tags: ['plant'] }));
    await cell('event|delete', event, (id) => c.deleteEvent(owner, id));

    // ── journal ──
    const journal = () => insert('journal', 'A good day', 'journal', { body: 'A good day.' });
    await created(
      'journal|create',
      async () => (await c.createJournal(owner, { body: 'Felt fine.' })).id,
    );
    await cell('journal|rename', journal, (id) =>
      c.updateJournal(owner, id, { title: 'A fine day' }),
    );
    await cell('journal|edit:body', journal, (id) =>
      c.updateJournal(owner, id, { body: 'A long day.' }),
    );
    await cell('journal|edit:kind', journal, (id) =>
      c.updateJournal(owner, id, { kind: 'feeling' }),
    );
    await cell('journal|tags', journal, (id) => c.updateJournal(owner, id, { tags: ['me'] }));

    // ── formula ──
    // Made by the service, so the stored spec is the validated one.
    const formula = async () => (await c.createFormula(owner, { spec: SPEC })).id;
    await cell('formula|rename', formula, (id) =>
      c.updateFormula(owner, id, { title: 'Flow rate' }),
    );
    await cell('formula|edit:spec', formula, (id) => c.updateFormula(owner, id, { spec: SPEC2 }));
    await cell('formula|edit:spec-same', formula, (id) =>
      c.updateFormula(owner, id, { spec: SPEC }),
    );
    await cell('formula|tags', formula, (id) => c.updateFormula(owner, id, { tags: ['api'] }));

    // ── contact ──
    const contact = () =>
      insert('contact', 'Ada Lovelace', 'contacts', {
        first_name: 'Ada',
        last_name: 'Lovelace',
        company: '',
        emails: [],
        country_code: '',
        cell: '',
        description: '',
      });
    await cell('contact|edit:first_name', contact, (id) =>
      c.updateContact(owner, id, { firstName: 'Ida' }),
    );
    await cell('contact|edit:cell', contact, (id) =>
      c.updateContact(owner, id, { countryCode: '+1', cell: '5550100' }),
    );
    await cell('contact|tags', contact, (id) => c.updateContact(owner, id, { tags: ['vip'] }));

    // ── location ──
    const location = () =>
      insert('location', 'Home', 'locations', {
        latitude: 1,
        longitude: 2,
        body: 'Home base.',
        address: '1 Road',
      });
    await cell('location|rename', location, (id) => c.updateLocation(owner, id, { title: 'Base' }));
    await cell('location|edit:body', location, (id) =>
      c.updateLocation(owner, id, { body: 'Main base.' }),
    );
    await cell('location|edit:body-same', location, (id) =>
      c.updateLocation(owner, id, { body: 'Home base.' }),
    );
    await cell('location|tags', location, (id) => c.updateLocation(owner, id, { tags: ['x'] }));

    // ── secret ──
    const secret = async () =>
      (
        await secrets.createSecret(owner, {
          title: 'Router',
          description: 'The plant router.',
          kind: 'password',
          tags: [],
          note: 'n',
          fields: [],
        })
      ).id;
    await cell('secret|rename', secret, (id) =>
      secrets.updateSecret(owner, id, { title: 'Switch' }),
    );
    await cell('secret|rename-same', secret, (id) =>
      secrets.updateSecret(owner, id, { title: 'Router' }),
    );
    await cell('secret|edit:description', secret, (id) =>
      secrets.updateSecret(owner, id, { description: 'The office router.' }),
    );
    await cell('secret|edit:note', secret, (id) =>
      secrets.updateSecret(owner, id, { note: 'changed' }),
    );
    await cell('secret|tags', secret, (id) => secrets.updateSecret(owner, id, { tags: ['net'] }));

    // ── draw ──
    const draw = async () => {
      const id = await insert('draw', 'Sketch', 'draw', {});
      await x(sql`insert into draws (node_id, scene) values (${id}, '{"elements":[]}'::jsonb)`);
      return id;
    };
    await cell('draw|rename', draw, (id) => c.updateDraw(owner, id, { title: 'Plan' }));
    await cell('draw|tags', draw, (id) => c.updateDraw(owner, id, { tags: ['plant'] }));
    await cell('draw|commit', draw, (id) =>
      c.commitDraw(owner, id, { elements: [{ id: 'e1', type: 'text', text: 'Pump' }] }),
    );

    // ── page ──
    const page = async () => {
      const id = await insert('page', 'Pump page', 'pages', {});
      await x(sql`insert into pages (node_id, doc, doc_text)
        values (${id}, ${JSON.stringify(DOC)}::jsonb, 'Pump overhaul.')`);
      return id;
    };
    await created('page|create', async () => (await c.createPage(owner, { title: 'P' })).id);
    await cell('page|rename', page, (id) => c.updatePage(owner, id, { title: 'Valve page' }));
    await cell('page|tags', page, (id) => c.updatePage(owner, id, { tags: ['plant'] }));
    await cell('page|edit:doc', page, (id) => c.updatePage(owner, id, { doc: DOC2 }));
    await cell('page|edit:doc-reindex-false', page, (id) =>
      // The route's PATCH body flag, passed as main passed it (A10 #7 drops it).
      (c.updatePage as (...a: unknown[]) => Promise<unknown>)(
        owner,
        id,
        { doc: DOC2 },
        { reindex: false },
      ),
    );
    await cell('page|commit', page, (id) => c.commitPage(owner, id, DOC2));
    await cell('page|delete', page, (id) => c.deletePage(owner, id));

    // ── table ──
    const table = async () => {
      const id = await insert('table', 'Readings', 'tables', {});
      await x(sql`insert into tables (node_id) values (${id})`);
      return id;
    };
    await cell('table|rename', table, (id) => c.updateTable(owner, id, { title: 'Levels' }));
    await cell('table|tags', table, (id) => c.updateTable(owner, id, { tags: ['plant'] }));

    // ── file ──
    const file = async () => {
      const name = `f-${randomUUID().slice(0, 8)}.txt`;
      writeFileSync(path.join(process.env.MANTLE_FILES_ROOT!, name), 'hello');
      return insert('file', name, 'files', {
        filename: name,
        extension: 'txt',
        mime_type: 'text/plain',
        size_bytes: 5,
        sha256: 'x',
        content: 'hello',
      });
    };
    await cell('file|rename', file, (id) =>
      f.renameFileById({ ownerId: owner, fileId: id, newStem: `r-${id.slice(0, 8)}` }),
    );
    await cell('file|indexing', file, (id) =>
      f.setIndexingMode({ ownerId: owner, nodeId: id, mode: 'metadata' }),
    );
    await cell('file|indexing-same', file, (id) =>
      f.setIndexingMode({ ownerId: owner, nodeId: id, mode: 'full' }),
    );

    if (RECORD === 'main') writeFileSync(MAIN_FILE, `${JSON.stringify(cells, null, 2)}\n`);
    if (RECORD === 'now') {
      writeFileSync(
        path.join(HERE, 'a10-content-changed.now.json'),
        `${JSON.stringify(cells, null, 2)}\n`,
      );
    }

    const main = JSON.parse(readFileSync(MAIN_FILE, 'utf8')) as Record<string, string>;
    let changes: Changes = { reasons: {}, cells: {} };
    try {
      changes = JSON.parse(readFileSync(CHANGES_FILE, 'utf8')) as Changes;
    } catch {
      // No changes named yet: every cell must answer as on main.
    }
    const want: Record<string, string> = { ...main };
    for (const [k, v] of Object.entries(changes.cells)) {
      expect(changes.reasons[v.why], `${k}: reason '${v.why}' is named`).toBeTruthy();
      expect(main[k], `${k}: a named change of a recorded cell`).toBeDefined();
      expect(v.now, `${k}: a named change changes the cell`).not.toBe(main[k]);
      want[k] = v.now;
    }
    expect(cells).toEqual(want);
  }, 300_000);
});
