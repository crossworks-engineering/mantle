/**
 * W7a fix round 2, on a migrated scratch database: a second Admin login L
 * (a user of Admin, no Moderator there), the anchor, and a member whose
 * private workspace L does not read.
 *
 *  N1: L fires a heartbeat of the Admin assistant: the fire's turn runs as
 *      L (its scope's login, no Moderator rights), so it neither reads the
 *      anchor's private item nor edits an Admin page only a Moderator may
 *      edit. A turn started on the system pool from inside L's scope
 *      answers L and refuses another login.
 *  N2: page_from_note, page_from_notes and page_from_file on a Read-only
 *      source, without supersede_source, are refused; the source unchanged.
 *  N3: api_docs_set onto a same-named file the scope cannot edit is refused
 *      and the file unchanged; api_docs_get never returns a docs file the
 *      scope cannot read; update_persona in Journal mode retires (and
 *      returns) only a learned rule the scope may edit: not for L.
 *  L:  only the anchor mounts a folder into a sandbox; L works only in the
 *      sandboxes it made, the anchor in every one.
 *  Nit: an item id written as a non-canonical uuid is refused.
 *
 * Only the model, its key, the embedder and the decider are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7a-fix2.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  calls: 0,
  scope: null as unknown,
  calls1: [] as Array<{ name: string; args: Record<string, unknown> }>,
  toolResults: [] as string[],
}));

vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-fake'),
}));
// secret_create seals with the box's master key; the test key is the
// viewer roles' and is not a sealing key.
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
}));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))),
  embedBatch: vi.fn(async (_o: string, texts: string[]) =>
    texts.map(() => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))),
  ),
}));
vi.mock('@mantle/decisions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Every pair is the same rule, live: the older one would be retired.
  judgeRulePairs: vi.fn(async (_o: string, pairs: unknown[]) => ({
    scores: pairs.map(() => ({ same: 1, replaces: 0 })),
    mode: 'live',
    threshold: 0.5,
    calls: 1,
    failed: 0,
    ms: 0,
  })),
}));
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async (opts: { messages: Array<{ role: string; content?: unknown }> }) => {
    h.calls += 1;
    for (const m of opts.messages) {
      if (m.role === 'tool') h.toolResults.push(JSON.stringify(m.content));
    }
    if (h.calls === 1) {
      const db = await import('@mantle/db');
      h.scope = db.currentScope();
      return {
        text: '',
        model: 'fake/model',
        toolCalls: h.calls1.map((c, i) => ({
          id: `t${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
    return { text: 'fired, done', model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('W7a fix round 2', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  /** The suite's own actor check mode, put back after (checks on below). */
  let suiteMode: string | undefined;
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let files: typeof import('@mantle/files');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const mem = randomUUID(); // a member: its private workspace
  const second = randomUUID(); // L: a user of Admin, no Moderator there
  const tag = `w7af${randomUUID().slice(0, 6)}`;
  const apiKeyId = randomUUID();
  const groupSlug = `${tag}-api`;
  let adminWs = '';
  let memWs = '';
  let adminPage = '';
  let ownerPrivatePage = '';
  let roNote = '';
  let roFile = '';
  let docsFile = ''; // the member's, named as the group's docs file
  let memSecretFile = ''; // the member's, Admin does not read it
  let olderRule = ''; // a learned rule of the agent (the Journal is Admin's)
  let inboxFolder = ''; // an Admin folder on disk
  let agent: import('@mantle/db').Agent;
  const ownerBox = `${tag}-obox`;
  const lBox = `${tag}-lbox`;
  /** Every outbound request the code made (the stub answers them). */
  const outbound: string[] = [];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  const makeIn = <T>(home: string, fn: () => Promise<T>) =>
    sys(() => m.withCreateHome({ createWs: home, privateWs: null, quiet: true }, fn));
  const privateFor = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${login}, true)::uuid)::text as ws`,
      )
    )[0]!.ws;
  const homeIn = (id: string, ws: string) =>
    sys(() =>
      m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`delete from item_grants where node_id = ${id}`);
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                             values (${id}, ${ws}, true)`);
      }),
    );
  const readOnlyIn = (id: string, ws: string) =>
    sys(() =>
      m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                             values (${id}, ${ws}, false) on conflict do nothing`);
      }),
    );
  const nodeState = async (id: string) =>
    JSON.stringify(
      await x(sql`select title, data, updated_at, superseded_by, superseded_reason, salience
                    from nodes n where id = ${id}`),
    );
  const inAdminTurn = <T>(login: string, fn: () => Promise<T>) =>
    rt.withAgentScope({ id: agent.id, workspaceId: adminWs }, fn, {
      ownerLoginId: login,
    });
  const dispatchAs = (login: string, slug: string, input: Record<string, unknown>) =>
    t.dispatchTool(
      {
        slug,
        handler: { kind: 'builtin', ref: slug },
        inputSchema: {},
      } as unknown as import('@mantle/db').Tool,
      input,
      {
        ownerId: owner,
        surface: { kind: 'web', loginId: login },
        agent: { slug: agent.slug, depth: 1, delegateTo: [] },
      },
    );
  const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? '' : String(r.error));

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7a-fix2-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SANDBOXD_URL = 'http://sandboxd.invalid';
    process.env.SANDBOXD_TOKEN = 'w7a-sandboxd-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string }) => {
        const url = String(input instanceof Request ? input.url : input);
        outbound.push(`${init?.method ?? 'GET'} ${url}`);
        // sandboxd makes a sandbox; everything else is offline.
        if (url === 'http://sandboxd.invalid/sandboxes' && init?.method === 'POST') {
          return Response.json({ containerId: 'c-new' });
        }
        return new Response('{"error":"offline in the W7a test"}', { status: 503 });
      }),
    );
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    t = turnCallDispatch(await import('@mantle/tools'));
    rt = await import('@mantle/runtime/agent');
    files = await import('@mantle/files');
    const hb = await import('@mantle/runtime/heartbeats');
    hb.registerHeartbeatTools();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mem}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member'),
      (${second}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Second Admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    memWs = await privateFor(mem);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${adminWs}, ${second}, false)
                on conflict (workspace_id, login_id) do update set moderator = false`);
    adminPage = (await makeIn(adminWs, () => c.createPage(owner, { title: `${tag} admin page` })))
      .id;
    ownerPrivatePage = (
      await makeIn(await privateFor(owner), () =>
        c.createPage(owner, { title: `${tag} owner private page` }),
      )
    ).id;
    roNote = (
      await makeIn(memWs, () =>
        c.createNote(owner, { title: `${tag} read-only note`, content: 'kept as is' }),
      )
    ).id;
    await readOnlyIn(roNote, adminWs);
    await sys(() => files.ensureFilesRootBranch(owner));
    roFile = (
      await makeIn(memWs, () =>
        files.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: `${tag}-read-only.md`,
          bytes: Buffer.from('# kept\n\nthe member file'),
        }),
      )
    ).id;
    await readOnlyIn(roFile, adminWs);
    // The member's private file under the API docs folder, named as the
    // group's docs file will be.
    await sys(() => files.ensureAutoFiledFolder(owner, 'api-docs'));
    docsFile = (
      await makeIn(memWs, () =>
        files.upsertFile({
          ownerId: owner,
          parentPath: t.API_DOCS_FOLDER_PATH,
          filename: `${groupSlug}.md`,
          bytes: Buffer.from('the member private docs'),
        }),
      )
    ).id;
    // Homed in the member's workspace; the API docs folder is shared with
    // Admin, so Admin reads it, Read only.
    await homeIn(docsFile, memWs);
    // A member file Admin does not read at all.
    memSecretFile = (
      await makeIn(memWs, () =>
        files.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: `${tag}-member-secret.md`,
          bytes: Buffer.from('the member secret docs'),
        }),
      )
    ).id;
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs)
      values (${owner}, ${groupSlug}, 'W7a API', ${'{}'}::text[])`);
    // An Admin folder that is on disk, to mount.
    const folder = await makeIn(adminWs, () =>
      files.createFolder({ ownerId: owner, parentPath: 'files', slug: `${tag}-inbox` }),
    );
    inboxFolder = folder.id;
    await mkdir(files.diskPathForLtree(folder.path)!, { recursive: true });
    // Sandboxes: the anchor's (made before 0268: no maker) and L's.
    await sys(() =>
      c.createSandboxRow({
        id: randomUUID(),
        ownerId: owner,
        name: ownerBox,
        image: 'test/image',
        status: 'running',
        containerId: 'c1',
      }),
    );
    await sys(() =>
      c.createSandboxRow({
        id: randomUUID(),
        ownerId: owner,
        name: lBox,
        image: 'test/image',
        status: 'running',
        containerId: 'c2',
        createdBy: second,
      }),
    );
    // The Admin assistant: reads and edits pages; a heartbeat of it.
    const { BUILTIN_TOOLS } = t;
    for (const slug of ['node_read', 'page_update']) {
      const def = BUILTIN_TOOLS.find((d) => d.slug === slug)!;
      await x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler)
        values (${owner}, ${slug}, ${def.name}, ${def.description},
                ${JSON.stringify(def.inputSchema)}::jsonb,
                ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb)
        on conflict do nothing`);
    }
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs) values
      (${owner}, ${`${tag}-reads`}, 'Reads', ${'{node_read,page_update}'}::text[])`);
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${owner}, 'openrouter', ${tag}, '\\x00'::bytea)`);
    const [row] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner,
        slug: `${tag}-admin`,
        name: 'Admin assistant',
        model: 'fake/model',
        provider: 'openrouter',
        apiKeyId,
        systemPrompt: 'p',
        workspaceId: adminWs,
        toolGroupSlugs: [`${tag}-reads`],
        memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
      })
      .returning();
    agent = row!;
    await x(sql`insert into skills (owner_id, slug, name, description)
      values (${owner}, ${`${tag}-check`}, 'Check in', 'Ask how things are going.')`);
    // L's heartbeat: only its maker fires it (W7 integration fix 4).
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                       schedule_kind, schedule, surface, created_by)
      values (${owner}, ${`${tag}-hb`}, 'Check', ${agent.slug}, ${`${tag}-check`},
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb, ${second})`);
    // A rule the Admin assistant learned (the Journal lives in Admin).
    olderRule = (
      await makeIn(adminWs, () =>
        c.createJournal(owner, {
          body: `${tag} prefers a formal tone in every reply`,
          kind: 'preference',
          author: 'agent',
          agentSlug: agent.slug,
          source: { via: 'update_persona', agent_slug: agent.slug },
        }),
      )
    ).id;
    // Both checks on, as every box since the pre-check removal
    // (docs/actors.md, "Pre-check deletion"): a tool's write to an item the
    // scope may not change is the database's to refuse now. This process's
    // actor check on (a login's scoped write on the write role, its check
    // on) and the scratch database's edit check on.
    suiteMode = process.env.MANTLE_ACTOR_CHECK;
    process.env.MANTLE_ACTOR_CHECK = 'on';
    await (
      await import('@mantle/db/test-support')
    ).superuserExec(scratch!.url, "select mantle_set_edit_check('on')");
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    delete process.env.SANDBOXD_URL;
    delete process.env.SANDBOXD_TOKEN;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    h.calls = 0;
    h.scope = null;
    h.calls1 = [];
    h.toolResults = [];
    outbound.length = 0;
  });

  it('N1: L fires a heartbeat; the turn runs as L, with L’s rights', async () => {
    h.calls1 = [
      { name: 'node_read', args: { node_id: ownerPrivatePage } },
      { name: 'page_update', args: { id: adminPage, title: 'changed by the fire' } },
    ];
    const before = await nodeState(adminPage);
    const res = await inAdminTurn(second, () =>
      dispatchAs(second, 'heartbeat_fire', { slug: `${tag}-hb` }),
    );
    expect(res.ok, errorOf(res)).toBe(true);
    expect(h.calls).toBeGreaterThan(1);
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: second, ws: [adminWs], modWs: [] });
    const results = h.toolResults.join(' ');
    // The anchor's private page is not read; the Moderator-only edit refused.
    expect(results).not.toContain(`${tag} owner private page`);
    expect(results).toMatch(/You cannot change this item/);
    expect(await nodeState(adminPage)).toBe(before);
  });

  it('N1: a turn started on the system pool from L’s scope answers L, never another login', async () => {
    const scope = await m.loginScopeFor(second);
    const run = (opts: { ownerLoginId?: string }) =>
      m.withTurnScope(
        scope,
        () =>
          m.asSystem(
            () =>
              rt.withAgentScope(
                { id: agent.id, workspaceId: adminWs },
                async () => m.currentScope(),
                opts,
              ),
            'admin-area',
          ),
        { writes: true },
      );
    expect(await run({})).toMatchObject({ kind: 'assistant', loginId: second, modWs: [] });
    await expect(run({ ownerLoginId: owner })).rejects.toThrow(/answers the login that called it/);
  });

  it('N2: a conversion that retires a Read-only source is refused, the source unchanged', async () => {
    const note = await nodeState(roNote);
    const file = await nodeState(roFile);
    const pagesBefore = (
      await x<{ n: number }>(sql`select count(*)::int as n from nodes where type = 'page'`)
    )[0]!.n;
    for (const login of [owner, second]) {
      const res = await inAdminTurn(login, async () => ({
        note: await dispatchAs(login, 'page_from_note', { note_id: roNote }),
        notes: await dispatchAs(login, 'page_from_notes', {
          note_ids: [roNote],
          title: `${tag} stitched`,
        }),
        file: await dispatchAs(login, 'page_from_file', { file_id: roFile }),
      }));
      for (const r of [res.note, res.notes, res.file]) {
        expect(r.ok).toBe(false);
        expect(errorOf(r)).toMatch(/You cannot change this item/);
      }
    }
    expect(await nodeState(roNote)).toBe(note);
    expect(await nodeState(roFile)).toBe(file);
    const pagesAfter = (
      await x<{ n: number }>(sql`select count(*)::int as n from nodes where type = 'page'`)
    )[0]!.n;
    expect(pagesAfter).toBe(pagesBefore);
  });

  it('a non-canonical uuid is refused, never dropped', async () => {
    // A tool whose own precondition does not refuse such an id (an array
    // argument, a resolver) still meets the edit check: it refuses the id
    // rather than dropping it and letting the write through.
    const forms = [
      roNote.replace(/-/g, ''),
      `{${roNote}}`,
      roNote.toUpperCase().replace(/-/g, ''),
      `${roNote.slice(0, 4)}-${roNote.slice(4).replace(/-/g, '')}`,
    ];
    const res = await inAdminTurn(owner, async () =>
      Promise.all(forms.map((id) => m.itemWriteRefusal([id], 'edit'))),
    );
    for (const r of res) expect(r).toMatch(/is not written as a uuid is/);
    // The canonical form is checked as before (Read only: refused).
    const canonical = await inAdminTurn(owner, () => m.itemWriteRefusal([roNote], 'edit'));
    expect(canonical).toMatch(/You cannot change this item/);
    // Not a uuid at all: left to the tool's own error.
    expect(await inAdminTurn(owner, () => m.itemWriteRefusal(['notes.x'], 'edit'))).toBeNull();
  });

  it('N3: api_docs_set onto a file the scope cannot edit is refused; api_docs_get never reads it', async () => {
    const before = await nodeState(docsFile);
    for (const login of [owner, second]) {
      const res = await inAdminTurn(login, () =>
        dispatchAs(login, 'api_docs_set', {
          group_slug: groupSlug,
          markdown: `# ${tag} API\n\nGET /weather returns the forecast. Auth: a bearer token.`,
        }),
      );
      expect(res.ok).toBe(false);
      expect(errorOf(res)).toMatch(/already exists/);
    }
    expect(await nodeState(docsFile)).toBe(before);
    const bytes = await sys(() => files.readFileById({ ownerId: owner, fileId: docsFile }));
    expect(bytes?.bytes.toString('utf8')).toBe('the member private docs');
    // The group pointed at a file the scope does not read: never returned.
    await x(sql`update tool_groups
                   set integration = ${JSON.stringify({ service: 'w7a', docsNodeId: memSecretFile })}::jsonb
                 where owner_id = ${owner} and slug = ${groupSlug}`);
    for (const login of [owner, second]) {
      const got = await inAdminTurn(login, () =>
        dispatchAs(login, 'api_docs_get', { group_slug: groupSlug }),
      );
      expect(got.ok, errorOf(got)).toBe(true);
      expect(JSON.stringify(got)).not.toContain('the member secret docs');
      expect((got as { output: { has_docs: boolean } }).output.has_docs).toBe(false);
    }
  });

  it('N3: update_persona in Journal mode retires only a rule the scope may edit', async () => {
    const before = await nodeState(olderRule);
    // L reads the Journal (Admin's) but edits no Admin item: the older rule
    // it repeats is neither retired nor returned as retired.
    const byL = await inAdminTurn(second, () =>
      dispatchAs(second, 'update_persona', {
        add: { kind: 'style', content: `${tag} prefers a formal tone in every reply` },
      }),
    );
    expect(JSON.stringify(byL)).not.toMatch(/"retired":\[/);
    expect(await nodeState(olderRule)).toBe(before);
    // The anchor moderates Admin: the same request retires it.
    const byAnchor = await inAdminTurn(owner, () =>
      dispatchAs(owner, 'update_persona', {
        add: { kind: 'style', content: `${tag} prefers a formal tone in every reply` },
      }),
    );
    expect(byAnchor.ok, errorOf(byAnchor)).toBe(true);
    expect((byAnchor as { output: { retired?: string[] } }).output.retired).toContain(
      `${tag} prefers a formal tone in every reply`,
    );
    const [after] = await x<{ by: string | null }>(
      sql`select superseded_by::text as by from nodes where id = ${olderRule}`,
    );
    expect(after!.by).not.toBeNull();
  });

  it('L: only the anchor mounts a folder into a sandbox', async () => {
    const refused = await inAdminTurn(second, () =>
      dispatchAs(second, 'sandbox_create', {
        name: `${tag}-lmount`,
        inbox_folder_id: inboxFolder,
      }),
    );
    expect(refused.ok).toBe(false);
    expect(errorOf(refused)).toMatch(/brain owner's login only/);
    expect(outbound.filter((u) => u.includes('sandboxd'))).toEqual([]);
    const made = await inAdminTurn(owner, () =>
      dispatchAs(owner, 'sandbox_create', {
        name: `${tag}-omount`,
        inbox_folder_id: inboxFolder,
      }),
    );
    expect(made.ok, errorOf(made)).toBe(true);
    // L may make a sandbox with no mount; it is recorded as L's.
    const own = await inAdminTurn(second, () =>
      dispatchAs(second, 'sandbox_create', { name: `${tag}-lplain` }),
    );
    expect(own.ok, errorOf(own)).toBe(true);
    const [row] = await x<{ by: string | null }>(
      sql`select created_by::text as by from sandboxes where name = ${`${tag}-lplain`}`,
    );
    expect(row!.by).toBe(second);
  });

  it('L: L works only in its own sandboxes; the anchor in every one', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['sandbox_exec', { command: 'cat /mnt/inbox/x' }],
      ['sandbox_ls', {}],
      ['sandbox_mcp_call', { tool: 'Read', arguments: {} }],
      ['sandbox_stop', {}],
      ['sandbox_rm', {}],
    ];
    for (const [slug, args] of calls) {
      const other = await inAdminTurn(second, () =>
        dispatchAs(second, slug, { sandbox: ownerBox, ...args }),
      );
      expect(other.ok, slug).toBe(false);
      expect(errorOf(other), slug).toMatch(/made by another login/);
      // Its own sandbox, and the anchor on either: past the maker check (the
      // daemon is offline here).
      const mine = await inAdminTurn(second, () =>
        dispatchAs(second, slug, { sandbox: lBox, ...args }),
      );
      expect(errorOf(mine), slug).not.toMatch(/made by another login/);
      for (const box of [ownerBox, lBox]) {
        const anchor = await inAdminTurn(owner, () =>
          dispatchAs(owner, slug, { sandbox: box, ...args }),
        );
        expect(errorOf(anchor), `${slug} ${box}`).not.toMatch(/made by another login/);
      }
    }
  });

  it('the tools that left the system list still work in the scope', async () => {
    // brain_capacity counts the whole brain (the member's items too), for L.
    const [all] = await x<{ n: number }>(
      sql`select count(*)::int as n from nodes where owner_id = ${owner} and type <> 'branch'`,
    );
    const cap = await inAdminTurn(second, () => dispatchAs(second, 'brain_capacity', {}));
    expect(cap.ok, errorOf(cap)).toBe(true);
    expect((cap as { output: { docs: { count: number } } }).output.docs.count).toBe(all!.n);
    // secret_create: the anchor's secret is made in its scope.
    const secret = await inAdminTurn(owner, () =>
      dispatchAs(owner, 'secret_create', {
        title: `${tag} safe PIN`,
        value: '0000',
        kind: 'password',
      }),
    );
    expect(secret.ok, errorOf(secret)).toBe(true);
    // api_tool_test reads the tool row and runs it in the scope.
    await x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler)
      values (${owner}, ${`${tag}_ping`}, 'Ping', 'Ping the test API.',
              ${JSON.stringify({ type: 'object', properties: {} })}::jsonb,
              ${JSON.stringify({ kind: 'http', method: 'GET', url: 'https://api.example.invalid/ping' })}::jsonb)`);
    const ping = await inAdminTurn(owner, () =>
      dispatchAs(owner, 'api_tool_test', { slug: `${tag}_ping` }),
    );
    expect(ping.ok, errorOf(ping)).toBe(true);
    expect(JSON.stringify(ping)).not.toMatch(/permission denied|allowlisted reason/);
    // (The team tools, team_chat_list and team_access_list, left in W7b.)
  });
});

/** The tools module with each dispatchTool call named an assistant turn's
 *  caller unless it names its own (every entry names one since A5 step 3b;
 *  these calls stand for a turn's, as they always did). */
function turnCallDispatch<T extends typeof import('@mantle/tools')>(tools: T): T {
  return {
    ...tools,
    dispatchTool: (...[tool, input, ctx, depth]: Parameters<T['dispatchTool']>) =>
      tools.dispatchTool(tool, input, { caller: tools.turnCaller(), ...ctx }, depth),
  };
}
