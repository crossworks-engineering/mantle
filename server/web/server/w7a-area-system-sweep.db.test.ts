/**
 * W7a fix round 2: every tool of AREA_SYSTEM_TOOLS (the Admin-area tools
 * that run WHOLE on the system pool after the area check) reads and writes
 * system tables only. Each runs here in an Admin turn, with the system pool
 * closed to the item tables: any statement it sends to the system pool that
 * reads or writes nodes, chunks, windows, facts, grants, pages, tables,
 * secrets or mail throws, and is recorded (its scope's own reads go to the
 * scoped pools, which are not closed). Every listed tool must pass, whatever its own answer is (the
 * sandbox daemon, the linked brains and Telegram are offline here).
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

/** The item tables a listed tool must never touch on the system pool. */
const ITEM_TABLE_RE =
  /\b(?:from|join|into|update)\s+(?:only\s+)?(?:"?public"?\.)?"?(nodes|content_chunks|content_chunk_windows|facts|item_grants|pages|tables|draws|secrets|node_snapshots|node_embeds|emails|email_attachments|space_items)"?(?![\w.])/i;

describe.skipIf(!URL)('AREA_SYSTEM_TOOLS touch no item on the system pool', () => {
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

  /** The system pool's client, with item statements refused while armed. */
  const trapped = <T extends object>(client: T): T =>
    new Proxy(client, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== 'function') return v;
        const fn = v as (...a: unknown[]) => unknown;
        if (prop === 'unsafe') {
          return (query: string, ...rest: unknown[]) => {
            // Any statement on the system pool while a listed tool runs: the
            // tool runs whole there (its scope's reads use the scoped pools).
            if (armed && ITEM_TABLE_RE.test(String(query))) {
              armed.push(String(query).slice(0, 200));
              throw new Error(`item table on the system pool: ${String(query).slice(0, 120)}`);
            }
            return fn.call(target, query, ...rest);
          };
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
    delete process.env.MANTLE_ADMIN_READS;
    process.env.SANDBOXD_URL = 'http://sandboxd.invalid';
    process.env.SANDBOXD_TOKEN = 'w7a-sweep-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"offline in the sweep"}', { status: 503 })),
    );
    const postgres = (await import('postgres')).default;
    const g = globalThis as unknown as { __mantleSql?: unknown; __mantleDb?: unknown };
    // The system pool is made lazily from this client (client.ts getAdminDb).
    g.__mantleDb = undefined;
    g.__mantleSql = trapped(postgres(scratch.url, { max: 10, prepare: false }));
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
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
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience)
      values (${owner}, ${`${tag}-api`}, 'Sweep API', ${'{}'}::text[], 'admin')`);
    await x(sql`insert into sandboxes (owner_id, name, image, status, container_id)
      values (${owner}, ${`${tag}-box`}, 'test/image', 'running', 'c1')`);
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                       schedule_kind, schedule, surface)
      values (${owner}, ${`${tag}-hb`}, 'Check', ${agent.slug}, 'none',
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb)`);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.SANDBOXD_URL;
    delete process.env.SANDBOXD_TOKEN;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Arguments that carry a call past its own checks where they can. */
  const argsFor = (slug: string): Record<string, unknown> => {
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
    for (const slug of t.AREA_SYSTEM_TOOLS) {
      const hits: string[] = [];
      armed = hits;
      let res: { ok: boolean; error?: string };
      try {
        res = await rt.withAgentScope(
          { id: agent.id, audience: 'admin', workspaceId: adminWs },
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

  it('the trap is live: an item read on the system pool is caught', async () => {
    const hits: string[] = [];
    armed = hits;
    try {
      await rt.withAgentScope(
        { id: agent.id, audience: 'admin', workspaceId: adminWs },
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
});
