/**
 * One audit row for every tool write, on every surface, on a real database
 * (workspaces arch A5 step 6d; gateway survey finding 6; docs/actors.md).
 *
 * The gate writes it (@mantle/db call-audit.ts, from enterCall, after the
 * call succeeded), as each process starts it at boot (startCallAudit). For
 * every entry a tool call comes in by, a read (`note_get`) and a write
 * (`note_update`) of a real note, with the real handlers, counting the
 * tool-call rows in audit_log (`api.write` naming a tool):
 *
 *   entry                  main: read  write   now: read  write
 *   web turn                     0     0             0     1
 *   Telegram turn                0     0             0     1
 *   heartbeat (its turn)         0     0             0     1
 *   run item                     0     0             0     1
 *   recipe step                  0     0             0     1 (the recipe's row names it)
 *   pending approval             0     0             0     1
 *   app broker                   0     0             0     1
 *   dev console                  0     0             0     1
 *   MCP OAuth login              0     0             0     1
 *   MCP stdio                    0     0             0     1
 *   MCP key                      0     1 (route)     0     1 (route, unchanged; gate none)
 *
 * The "main" column is main's writers: the only tool-call row main wrote
 * was the /api/mcp route's for an API key (lib/mcp-auth.ts auditMcpKeyCall,
 * kept), and an HTTP route's own `api.write` per request (auditMutation,
 * kept as it was) names no tool. So no surface doubles.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a5-call-audit.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

describe.skipIf(!URL)('one audit row for every tool write (A5 step 6d)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let content: typeof import('@mantle/content');
  let dir = '';
  const tag = `a5ca${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const email = `${tag}-o@example.invalid`;
  let noteId = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** The tool-call rows written since the table was last cleared. */
  const toolRows = async () => {
    await m.callAuditsSettled();
    return x<{
      actor_email: string;
      method: string;
      path: string | null;
      detail: Record<string, unknown>;
    }>(
      sql`select actor_email, method, path, detail from audit_log
           where action = 'api.write' and detail ? 'tool' order by created_at`,
    );
  };
  const clear = () => x(sql`delete from audit_log`);

  const row = async (slug: string) => {
    const r = await m.asSystem(() => t.resolveTool(owner, slug), 'test');
    expect(r, slug).toBeTruthy();
    return r!;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a5-call-audit-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    content = await import('@mantle/content');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${email}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    const note = await m.asSystem(
      () => content.createNote(owner, { title: `${tag} note`, content: 'body' }),
      'test',
    );
    noteId = note.id;
    m.startCallAudit();
  }, 240_000);

  afterAll(async () => {
    m?.stopCallAudit();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const asOwner = <T>(fn: () => Promise<T>) =>
    m.runAsActor(m.loginActor(owner, 'owner'), fn) as Promise<T>;

  type Entry = {
    name: string;
    run: (slug: string, input: Record<string, unknown>) => Promise<boolean>;
    writeRows: number;
  };

  /** A dispatch entry: its caller and surface, run as the owner. */
  const dispatched =
    (caller: (tool: Awaited<ReturnType<typeof row>>) => unknown, surface?: unknown) =>
    async (slug: string, input: Record<string, unknown>) => {
      const tool = await row(slug);
      const res = await asOwner(() =>
        t.dispatchTool(tool, input, {
          ownerId: owner,
          ...(surface ? { surface: surface as never } : {}),
          caller: caller(tool) as never,
        }),
      );
      return res.ok;
    };

  /** An MCP client on the one surface (as /api/mcp, or the stdio server). */
  const mcp =
    (via: 'oauth' | 'key' | 'stdio') => async (slug: string, input: Record<string, unknown>) => {
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      let server: InstanceType<typeof McpServer>;
      if (via === 'stdio') {
        // As server/mcp builds it; the gate binds login(owner) per call.
        server = ls.buildMantleMcpServer(owner) as never;
      } else {
        const prepared = await ls.prepareCallerTools({
          role: 'admin',
          anchorId: owner,
          loginId: owner,
          via,
          write: true,
          ...(via === 'key' ? { keyId: randomUUID() } : { oauthClientId: 'c1' }),
        });
        server = new McpServer({ name: 'test', version: '0' });
        ls.registerPreparedTools(server, prepared);
      }
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: tag, version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      try {
        const r = (await asOwner(() => c.callTool({ name: slug, arguments: input }))) as Reply;
        if (r.isError) console.error(`[${via}] ${slug}:`, text(r));
        return !(r.isError ?? false);
      } finally {
        await c.close();
      }
    };

  const WEB = { kind: 'web', loginId: owner };
  const allowed = (tool: unknown) => ({ ok: true as const, tool });
  const ENTRIES: Entry[] = [
    { name: 'web turn', run: dispatched(() => t.turnCaller(), WEB), writeRows: 1 },
    {
      name: 'Telegram turn',
      run: dispatched(() => t.turnCaller(), { kind: 'telegram' }),
      writeRows: 1,
    },
    { name: 'heartbeat (its turn)', run: dispatched(() => t.turnCaller(), WEB), writeRows: 1 },
    { name: 'run item', run: dispatched(() => t.runCaller()), writeRows: 1 },
    { name: 'pending approval', run: dispatched(() => t.pendingCaller(), WEB), writeRows: 1 },
    {
      name: 'app broker',
      run: dispatched((tool) => t.appBrokerCaller({ kind: 'web' }, allowed(tool) as never), WEB),
      writeRows: 1,
    },
    { name: 'dev console', run: dispatched(() => t.ownerWebCaller(), WEB), writeRows: 1 },
    { name: 'MCP OAuth login', run: mcp('oauth'), writeRows: 1 },
    { name: 'MCP stdio', run: mcp('stdio'), writeRows: 1 },
    // Its route writes the row before the call (unchanged): the gate none.
    { name: 'MCP key', run: mcp('key'), writeRows: 0 },
  ];

  /** Each entry's read and write, counting the tool-call rows of each. */
  const countRows = async () => {
    const table: Record<string, { read: number; write: number }> = {};
    for (const e of ENTRIES) {
      await clear();
      expect(await e.run('note_get', { id: noteId }), `${e.name} read`).toBe(true);
      const read = (await toolRows()).length;
      await clear();
      expect(
        await e.run('note_update', { id: noteId, content: `changed by ${e.name}` }),
        `${e.name} write`,
      ).toBe(true);
      const write = (await toolRows()).length;
      table[e.name] = { read, write };
    }
    return table;
  };

  it("before: main's writers leave no tool-call row on any of these entries", async () => {
    // The gate's row off is main's code path for every entry here (the
    // route's own rows, a key's included, are written by the routes, which
    // these calls do not pass through).
    m.stopCallAudit();
    try {
      const table = await countRows();
      expect(table).toEqual(
        Object.fromEntries(ENTRIES.map((e) => [e.name, { read: 0, write: 0 }])),
      );
    } finally {
      m.startCallAudit();
    }
  });

  it('every entry: a read leaves no row, a write exactly one', async () => {
    expect(await countRows()).toEqual(
      Object.fromEntries(ENTRIES.map((e) => [e.name, { read: 0, write: e.writeRows }])),
    );
  });

  it('the row names the login, the tool, its entry and the note it changed', async () => {
    await clear();
    expect(await ENTRIES[0]!.run('note_update', { id: noteId, content: 'again' })).toBe(true);
    expect(await toolRows()).toEqual([
      {
        actor_email: email,
        method: 'TOOL',
        path: null,
        detail: expect.objectContaining({
          tool: 'note_update',
          entry: 'turn',
          via: 'turn',
          surface: 'web',
          targets: [noteId],
        }),
      },
    ]);
    await clear();
    expect(await mcp('oauth')('note_update', { id: noteId, content: 'over mcp' })).toBe(true);
    expect(await toolRows()).toEqual([
      {
        actor_email: email,
        method: 'MCP',
        path: '/api/mcp',
        detail: expect.objectContaining({
          tool: 'note_update',
          entry: 'mcp',
          via: 'oauth',
          oauthClientId: 'c1',
        }),
      },
    ]);
  });

  /** A call in a web turn as the owner: its result (an MCP-only builtin
   *  by a row made for it, as /api/v1 makes it). */
  const turn = (slug: string, input: Record<string, unknown>) =>
    m
      .asSystem(() => t.resolveTool(owner, slug), 'test')
      .then((r) => r ?? ({ slug, handler: { kind: 'builtin', ref: slug } } as never))
      .then((tool) =>
        asOwner(() =>
          t.dispatchTool(tool, input, {
            ownerId: owner,
            surface: WEB as never,
            caller: t.turnCaller(),
          }),
        ),
      );
  /** The targets of the one row a call left, or null when it left none. */
  const targetsOfCall = async (slug: string, input: Record<string, unknown>) => {
    // The rows of the calls before it (each settles after its call) first.
    await m.callAuditsSettled();
    await clear();
    const res = await turn(slug, input);
    const rows = await toolRows();
    expect(rows.length, `${slug}: ${res.ok ? 'ok' : res.error}`).toBe(res.ok ? 1 : 0);
    return {
      ok: res.ok,
      output: res.ok ? (res.output as Record<string, unknown>) : null,
      targets: rows[0] ? ((rows[0].detail.targets as string[] | undefined) ?? []) : null,
    };
  };
  const newNote = async (title: string) =>
    (
      await m.asSystem(
        () => content.createNote(owner, { title: `${tag} ${title}`, content: 'x' }),
        'test',
      )
    ).id;

  // R0 fix round M1: the items a call names come from its policy's
  // `itemArgs`, one declaration, as main's item lists named them: a list,
  // a Recall map by its slug (resolved before the call runs), a Recall
  // revision's map, a conversion's sources, a link's item. A refused call
  // leaves no row, as before.
  it('tree_item_move names every item it moved; a refused move leaves no row', async () => {
    const [a, b] = [await newNote('move a'), await newNote('move b')];
    const folder = await turn('tree_folder_create', { kind: 'notes', name: `${tag} dest` });
    expect(folder.ok, folder.ok ? '' : folder.error).toBe(true);
    const dest = (folder as { output: { id: string } }).output.id;
    const moved = await targetsOfCall('tree_item_move', {
      kind: 'notes',
      item_ids: [a, b],
      folder_id: dest,
    });
    expect(moved.ok).toBe(true);
    expect([...moved.targets!].sort()).toEqual([a, b].sort());
    const refused = await targetsOfCall('tree_item_move', {
      kind: 'notes',
      item_ids: [randomUUID()],
      folder_id: dest,
    });
    expect(refused).toMatchObject({ ok: false, targets: null });
  });

  it('a Recall map named by its slug is named by its item, even by a delete or a slug change; an unknown slug leaves no row', async () => {
    const made = await turn('recall_map_create', {
      title: `${tag} map`,
      enter_when: 'testing the audit targets',
    });
    expect(made.ok, made.ok ? '' : made.error).toBe(true);
    const out = (made as { output: { map: string; id: string; version: number } }).output;
    const mapNode = out.id;
    const put = await targetsOfCall('recall_card_put', {
      map: out.map,
      title: 'Audit card',
      body: 'The card body.',
    });
    expect(put.ok).toBe(true);
    expect(put.targets).toContain(mapNode);
    const revisions = await turn('recall_revisions', { map: out.map });
    const listed = (revisions as { output?: { version?: number; revisions?: { id: string }[] } })
      .output;
    const revision = listed?.revisions?.[0]?.id;
    expect(revision, 'a revision of the map').toBeTruthy();
    const version = listed?.version ?? out.version;
    const renamed = await targetsOfCall('recall_map_set_slug', {
      map: out.map,
      slug: `${tag}-renamed`,
      version,
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.targets).toContain(mapNode);
    const restored = await targetsOfCall('recall_revision_restore', { revision_id: revision });
    if (restored.ok) expect(restored.targets).toContain(mapNode);
    const unknown = await targetsOfCall('recall_card_put', {
      map: `${tag}-no-such-map`,
      title: 'x',
      body: 'x',
    });
    expect(unknown).toMatchObject({ ok: false, targets: null });
    const deleted = await targetsOfCall('recall_map_delete', {
      map: `${tag}-renamed`,
      confirm: true,
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.targets).toContain(mapNode);
  });

  it('page_from_notes names its source notes and the page it made; a missing source leaves no row', async () => {
    const [a, b] = [await newNote('source a'), await newNote('source b')];
    const made = await targetsOfCall('page_from_notes', {
      note_ids: [a, b],
      title: `${tag} combined`,
      supersede_source: false,
    });
    expect(made.ok).toBe(true);
    const page = made.output!.id as string;
    expect([...made.targets!].sort()).toEqual([a, b, page].sort());
    const refused = await targetsOfCall('page_from_notes', {
      note_ids: [randomUUID()],
      title: `${tag} none`,
    });
    expect(refused).toMatchObject({ ok: false, targets: null });
  });

  it('node_share and node_unshare name the item; a refused share leaves no row', async () => {
    const id = await newNote('shared');
    const shared = await targetsOfCall('node_share', { id });
    expect(shared.ok).toBe(true);
    expect(shared.targets).toEqual([id]);
    const closed = await targetsOfCall('node_unshare', { id });
    expect(closed.ok).toBe(true);
    expect(closed.targets).toEqual([id]);
    const refused = await targetsOfCall('node_share', { id: randomUUID() });
    expect(refused).toMatchObject({ ok: false, targets: null });
  });

  it('a delete names the item it deleted (its item argument; R0 fix round M1)', async () => {
    const gone = await m.asSystem(
      () => content.createNote(owner, { title: `${tag} to delete`, content: 'x' }),
      'test',
    );
    await clear();
    // An MCP-only tool: its output says only "deleted".
    expect(await mcp('oauth')('note_delete', { id: gone.id })).toBe(true);
    expect(await toolRows()).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ tool: 'note_delete', targets: [gone.id] }),
      }),
    ]);
  });

  it("a recipe's write step is named in the recipe's one row", async () => {
    await clear();
    const recipe = {
      slug: `${tag}_recipe`,
      handler: {
        kind: 'recipe',
        steps: [{ tool: 'note_update', input: { id: noteId, content: 'by a recipe' } }],
      },
      inputSchema: { type: 'object', properties: {} },
    } as never;
    const res = await asOwner(() =>
      t.dispatchTool(recipe, {}, { ownerId: owner, surface: WEB as never, caller: t.turnCaller() }),
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const rows = await toolRows();
    expect(rows.map((r) => [r.detail.tool, r.detail.nested])).toEqual([
      [`${tag}_recipe`, ['note_update']],
    ]);
  });
});
