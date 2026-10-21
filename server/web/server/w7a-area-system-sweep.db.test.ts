/**
 * W7a fix round 2: every `systemWhole` tool (the Admin-area tools
 * that run WHOLE on the system pool after the area check) reads and writes
 * system tables only. Each runs here in an Admin turn, with the system pool
 * closed to the item tables: any statement it sends to the system pool that
 * reads or writes nodes, chunks, windows, facts, grants, pages, tables,
 * secrets or mail throws, and is recorded (its scope's own reads go to the
 * scoped pools, which are not closed). Every listed tool must pass, whatever its own answer is.
 *
 * Fix round 3 deepens it: the trap catches tagged-template statements on the
 * pool's client too (not only drizzle's `unsafe`), the closed list holds every
 * item and conversation table, and the sandbox daemon and the linked brain
 * answer 200 (a stub that speaks their JSON and MCP), with real sandboxes, a
 * real peer, tools, groups and a heartbeat seeded, so each handler reaches its
 * own writes. Telegram stays offline.
 *
 * A name-based test pins the same list's shape (item-write-gate.test.ts);
 * this one runs the handlers.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7a-area-system-sweep.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

// The vault and the peer token are sealed with the box's master key; the
// test key is the viewer roles' and is not a sealing key.
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => 'w7a-sweep-sealed-value'),
}));

/** The item tables a listed tool must never touch on the system pool. */
const ITEM_TABLE_RE =
  /\b(?:from|join|into|update)\s+(?:only\s+)?(?:"?public"?\.)?"?(nodes|content_chunks|content_chunk_windows|facts|item_grants|pages|tables|draws|secrets|node_snapshots|node_embeds|emails|email_attachments|space_items|assistant_messages|entities|entity_edges|node_comments|item_marks|recall_maps|recall_nodes|accepted_snapshots|team_messages|tool_result_chunks)"?(?![\w.])/i;

/** The text of a tagged-template call's statement (its strings joined). */
function templateText(args: unknown[]): string | null {
  const first = args[0] as { raw?: unknown } | undefined;
  return Array.isArray(first) && Array.isArray(first.raw) ? (first as string[]).join('?') : null;
}

/** The stub's answer for the sandbox daemon: one body every route reads. */
const SANDBOXD_BODY = {
  containerId: 'c-new',
  exitCode: 0,
  stdout: '',
  stderr: '',
  sandboxes: [],
  disk: null,
  filesPreserved: true,
  filesDir: null,
  wake: 'true',
  result: { tools: [], content: [{ type: 'text', text: '{}' }] },
};

/** The stub's answer for one MCP JSON-RPC message from the peer client. */
function mcpReply(msg: { id?: unknown; method?: string; params?: { protocolVersion?: string } }) {
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const result =
    msg.method === 'initialize'
      ? {
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'w7a-peer', version: '1.0.0' },
        }
      : msg.method === 'tools/list'
        ? { tools: [{ name: 'search', description: 'Search.', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: '{"ok":true}' }] };
  return Response.json({ jsonrpc: '2.0', id: msg.id, result });
}

describe.skipIf(!URL)('the systemWhole tools touch no item on the system pool', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let dir = '';
  const owner = randomUUID();
  const tag = `w7asw${randomUUID().slice(0, 6)}`;
  let adminWs = '';
  let agent: import('@mantle/db').Agent;
  /** Set while a listed tool runs: the statements it sent that broke the rule. */
  let armed: string[] | null = null;

  /** Record and refuse an item statement while armed. */
  const check = (query: string) => {
    if (armed && ITEM_TABLE_RE.test(query)) {
      armed.push(query.slice(0, 200));
      throw new Error(`item table on the system pool: ${query.slice(0, 120)}`);
    }
  };

  /** The system pool's client, with item statements refused while armed:
   *  drizzle's `unsafe` and a tagged-template call on the client or a
   *  transaction of it alike. */
  const trapped = <T extends object>(client: T): T =>
    new Proxy(client, {
      apply(target, thisArg, args: unknown[]) {
        const text = templateText(args);
        if (text !== null) check(text);
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== 'function') return v;
        const fn = v as (...a: unknown[]) => unknown;
        if (prop === 'unsafe') {
          return (query: string, ...rest: unknown[]) => {
            // Any statement on the system pool while a listed tool runs: the
            // tool runs whole there (its scope's reads use the scoped pools).
            check(String(query));
            return fn.call(target, query, ...rest);
          };
        }
        // A reserved connection too: the system pool sends each statement
        // with its actor on one (arch A2a, client.ts actorClient).
        if (prop === 'reserve') {
          return async (...args: unknown[]) => trapped((await fn.apply(target, args)) as object);
        }
        if (prop === 'begin' || prop === 'savepoint') {
          return (...args: unknown[]) => {
            const last = args.length - 1;
            const cb = args[last] as (tx: object) => unknown;
            args[last] = (tx: object) => cb(trapped(tx));
            return fn.apply(target, args);
          };
        }
        return fn.bind(target);
      },
    });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7a-sweep-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SANDBOXD_URL = 'http://sandboxd.invalid';
    process.env.SANDBOXD_TOKEN = 'w7a-sweep-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: unknown }) => {
        const req = input instanceof Request ? input : null;
        const url = String(req ? req.url : input);
        // The sandbox daemon: 200 with a body every route reads.
        if (url.startsWith('http://sandboxd.invalid/')) return Response.json(SANDBOXD_BODY);
        // The linked brain: its MCP endpoint, and its federation routes. An
        // address literal from the documentation range (TEST-NET-1): the
        // egress fetch resolves a name before it connects and refuses one
        // that does not resolve (A10 part 1 fix round 1), and a literal asks
        // no DNS.
        if (url.startsWith('http://192.0.2.10/api/mcp')) {
          if ((req?.method ?? 'POST') !== 'POST') return new Response(null, { status: 405 });
          const raw = req ? await req.clone().text() : String(init?.body ?? '');
          const msg = JSON.parse(raw || '{}') as Parameters<typeof mcpReply>[0];
          return mcpReply(msg);
        }
        if (url.startsWith('http://192.0.2.10/')) {
          return Response.json({ nodes: [], count: 0, chunks: [], node: { id: 'n1' } });
        }
        return new Response('{"error":"offline in the sweep"}', { status: 503 });
      }),
    );
    const postgres = (await import('postgres')).default;
    const g = globalThis as unknown as { __mantleSql?: unknown; __mantleDb?: unknown };
    // The system pool is made lazily from this client (client.ts getAdminDb).
    g.__mantleDb = undefined;
    g.__mantleSql = trapped(postgres(scratch.url, { max: 10, prepare: false }));
    m = await import('@mantle/db');
    // The narrow route's own pool is a system pool too: the same trap on
    // it, made by the pool's own factory (its size, startup parameters,
    // and the system pool's parsers once drizzle has set them).
    await m.systemDb.execute(sql`select 1`);
    {
      const rr = await import('../../../packages/db/src/runtime-role');
      const pools = await import('../../../packages/db/src/gateway/pools');
      const url = rr.narrowDatabaseUrl();
      (globalThis as unknown as { __mantleNarrowSql?: unknown }).__mantleNarrowSql = url
        ? trapped(pools.newNarrowPool(url, g.__mantleSql as ReturnType<typeof postgres>))
        : null;
    }
    t = turnCallDispatch(await import('@mantle/tools'));
    rt = await import('@mantle/runtime/agent');
    (await import('@mantle/runtime/heartbeats')).registerHeartbeatTools();
    const x = (q: ReturnType<typeof sql>) => m.systemDb.execute(q);
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    adminWs = (
      (await x(sql`select id::text as id from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)) as unknown as {
        id: string;
      }[]
    )[0]!.id;
    const [row] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner,
        slug: `${tag}-admin`,
        name: 'Admin assistant',
        model: 'test/model',
        systemPrompt: 'p',
        workspaceId: adminWs,
      })
      .returning();
    agent = row!;
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs)
      values (${owner}, ${`${tag}-api`}, 'Sweep API', ${'{}'}::text[])`);
    await x(sql`insert into sandboxes (owner_id, name, image, status, container_id) values
      (${owner}, ${`${tag}-box`}, 'test/image', 'running', 'c1'),
      (${owner}, ${`${tag}-rmbox`}, 'test/image', 'running', 'c2')`);
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                       schedule_kind, schedule, surface)
      values (${owner}, ${`${tag}-hb`}, 'Check', ${agent.slug}, 'none',
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb)`);
    // Real tools for the tools that name one: one to read, one to delete.
    for (const slug of [`${tag}_tool`, `${tag}_del`]) {
      await x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler)
        values (${owner}, ${slug}, 'Sweep tool', 'A tool.', ${'{"type":"object"}'}::jsonb,
                ${JSON.stringify({ kind: 'http', url: 'https://example.invalid/x' })}::jsonb)`);
    }
    // A linked brain, paired (its token sealed by the stub key).
    const c = await import('@mantle/content');
    await m.asSystem(
      () =>
        c.createPeer(owner, {
          displayName: `${tag} peer`,
          baseUrl: 'http://192.0.2.10',
          outboundToken: 'w7a-peer-token',
        }),
      'test',
    );
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.SANDBOXD_URL;
    delete process.env.SANDBOXD_TOKEN;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Real names for the tools that take one, so each reaches its writes. */
  const realArgs = (): Record<string, Record<string, unknown>> => ({
    sandbox_rm: { sandbox: `${tag}-rmbox` },
    sandbox_exec: { sandbox: `${tag}-box`, command: 'true' },
    sandbox_autostart: { sandbox: `${tag}-box`, command: 'true' },
    sandbox_mcp_call: { sandbox: `${tag}-box`, tool: 'search' },
    // The sandbox's own group (sbx-<name>): any other is refused.
    sandbox_publish: { sandbox: `${tag}-box`, port: 8000 },
    tool_group_ensure: { slug: `${tag}-api`, tool_slugs: [`${tag}_tool`] },
    worker_group_ensure: { slug: `${tag}-wg`, name: 'Sweep workers', members: [agent.slug] },
    api_tool_create: {
      slug: `${tag}_new`,
      name: 'New sweep tool',
      description: 'A new tool.',
      url: 'https://example.invalid/new',
      group_slug: `${tag}-api`,
    },
    api_tool_delete: { slug: `${tag}_del` },
    api_tool_get: { slug: `${tag}_tool` },
    api_skill_set: { group_slug: `${tag}-api`, body: 'Use the sweep tools.' },
    recipe_tool_create: {
      slug: `${tag}_recipe`,
      name: 'Sweep recipe',
      description: 'A recipe.',
      steps: [{ tool: `${tag}_tool`, input: {} }],
    },
    peer_tools: { peer: `${tag} peer` },
    peer_call: { peer: `${tag} peer`, tool: 'search', args: {} },
    peer_query: { peer: `${tag} peer`, query: 'x' },
    peer_node_get: { peer: `${tag} peer`, nodeId: randomUUID() },
    peer_search_chunks: { peer: `${tag} peer`, query: 'x' },
  });

  /** Arguments that carry a call past its own checks where they can. */
  const argsFor = (slug: string): Record<string, unknown> => {
    const real = realArgs()[slug];
    if (real) return real;
    const def = t.getBuiltin(slug);
    const schema = (def?.inputSchema ?? {}) as {
      properties?: Record<string, { type?: string; enum?: unknown[] }>;
      required?: string[];
    };
    const out: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(schema.properties ?? {})) {
      if (p.enum && p.enum.length > 0) out[name] = p.enum[0];
      else if (/sandbox/.test(name)) out[name] = `${tag}-box`;
      else if (/^agent/.test(name)) out[name] = agent.slug;
      else if (/group/.test(name)) out[name] = `${tag}-api`;
      else if (name === 'slug') out[name] = slug.startsWith('heartbeat') ? `${tag}-hb` : 'w7a_x';
      else if (/chat_?id/i.test(name)) out[name] = 1;
      else if (p.type === 'number' || p.type === 'integer') out[name] = 1;
      else if (p.type === 'boolean') out[name] = false;
      else if (p.type === 'array') out[name] = [];
      else if (p.type === 'object') out[name] = {};
      else if (!schema.required?.includes(name)) continue;
      else out[name] = 'w7a';
    }
    return out;
  };

  it('every listed tool runs without an item statement on the system pool', async () => {
    const broke: Record<string, string[]> = {};
    const whole = t.listBuiltins().filter((d) => t.policySystemWhole(d.policy));
    for (const slug of whole.map((d) => d.slug)) {
      const hits: string[] = [];
      armed = hits;
      let res: { ok: boolean; error?: string };
      try {
        res = await rt.withAgentScope(
          { id: agent.id, workspaceId: adminWs },
          () =>
            t.dispatchTool(
              {
                slug,
                handler: { kind: 'builtin', ref: slug },
                inputSchema: {},
              } as unknown as import('@mantle/db').Tool,
              argsFor(slug),
              {
                ownerId: owner,
                surface: { kind: 'web', loginId: owner },
                agent: { slug: agent.slug, depth: 1, delegateTo: [] },
              },
            ),
          { ownerLoginId: owner },
        );
      } finally {
        armed = null;
      }
      if (hits.length > 0) broke[slug] = hits;
      // A call may fail on its own terms (offline daemon, a dummy argument),
      // never on the scope.
      const err = res.ok ? '' : String(res.error);
      expect(err, slug).not.toMatch(
        /item table on the system pool|permission denied|allowlisted reason|is not registered/,
      );
    }
    expect(broke).toEqual({});
  });

  it('the stub carries the sandbox and peer tools to their answers', async () => {
    const run = (slug: string) =>
      rt.withAgentScope(
        { id: agent.id, workspaceId: adminWs },
        () =>
          t.dispatchTool(
            {
              slug,
              handler: { kind: 'builtin', ref: slug },
              inputSchema: {},
            } as unknown as import('@mantle/db').Tool,
            argsFor(slug),
            { ownerId: owner, surface: { kind: 'web', loginId: owner } },
          ),
        { ownerLoginId: owner },
      );
    for (const slug of ['sandbox_exec', 'sandbox_stop', 'peer_tools', 'peer_call', 'peer_query']) {
      const res = await run(slug);
      expect(res.ok, `${slug}: ${res.ok ? '' : String(res.error)}`).toBe(true);
    }
  });

  it('the trap is live for a tagged-template statement too', async () => {
    const g = globalThis as unknown as {
      __mantleSql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    };
    const hits: string[] = [];
    armed = hits;
    try {
      await g.__mantleSql`select id from nodes limit 1`.catch(() => null);
    } catch {
      /* the trap throws before the statement is sent */
    } finally {
      armed = null;
    }
    expect(hits.length).toBe(1);
  });

  it('the trap is live: an item read on the system pool is caught', async () => {
    const hits: string[] = [];
    armed = hits;
    try {
      await rt.withAgentScope(
        { id: agent.id, workspaceId: adminWs },
        () =>
          m
            .asSystem(
              async () => await m.db.select({ id: m.nodes.id }).from(m.nodes).limit(1),
              'admin-area',
            )
            .catch(() => null),
        { ownerLoginId: owner },
      );
    } finally {
      armed = null;
    }
    expect(hits.length).toBe(1);
  });

  // Plan v3.2 S7a part a3: the narrow-role proof. Every listed tool, the trap
  // off (its statements reach Postgres), the box's actor check in warn (the
  // write count's trigger is on): with the switch on its system-pool work
  // runs as mantle_system_narrow (uses by system:admin-area, no denial:
  // vitest.setup.ts fails the test on one); with the switch off, as on a
  // box today, none of its writes is a content write the count would
  // report (migration 0312 narrow-content-write, narrow-cascade-delete), so
  // the flip refuses nothing these tools do. Last in the file: it reopens
  // the pools without the trap.
  it('the narrow-role proof: on the narrow role with the switch on, no content write counted with it off', async () => {
    const actor = await import('../../../packages/db/src/actor');
    const roles = await import('../../../packages/db/src/runtime-role');
    const postgres = (await import('postgres')).default;
    const su = postgres(scratch!.url, { max: 1, prepare: false, onnotice: () => {} });
    const whole = t.listBuiltins().filter((d) => t.policySystemWhole(d.policy));
    const runAll = async () => {
      for (const slug of whole.map((d) => d.slug)) {
        await rt.withAgentScope(
          { id: agent.id, workspaceId: adminWs },
          () =>
            t.dispatchTool(
              {
                slug,
                handler: { kind: 'builtin', ref: slug },
                inputSchema: {},
              } as unknown as import('@mantle/db').Tool,
              argsFor(slug),
              {
                ownerId: owner,
                surface: { kind: 'web', loginId: owner },
                agent: { slug: agent.slug, depth: 1, delegateTo: [] },
              },
            ),
          { ownerLoginId: owner },
        );
      }
    };
    const reopen = async (on: boolean) => {
      await m.closeDb();
      const g = globalThis as unknown as { __mantleSql?: unknown; __mantleDb?: unknown };
      g.__mantleSql = undefined;
      g.__mantleDb = undefined;
      roles.setNarrowSystemForTests(on);
    };
    const [box] = await su<{ mode: string }[]>`select mantle_actor_check_box_mode() as mode`;
    try {
      await su`select mantle_set_actor_check('warn', 50, 'test')`;
      expect(whole.length).toBeGreaterThan(30);
      await reopen(true);
      actor.takeNarrowUses();
      await runAll();
      expect(actor.takeNarrowUses()['system:admin-area'] ?? 0).toBeGreaterThan(whole.length);
      expect(actor.takeNarrowWrites()).toEqual([]);
      await reopen(false);
      await runAll();
      expect(actor.takeNarrowUses()).toEqual({});
      expect(actor.takeNarrowWrites()).toEqual([]);
    } finally {
      await m.closeDb();
      roles.setNarrowSystemForTests(null);
      await su`select mantle_set_actor_check(${box!.mode}, 50, 'test')`;
      await su.end();
    }
  }, 300_000);
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
