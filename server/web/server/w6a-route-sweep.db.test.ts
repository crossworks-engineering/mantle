/**
 * W6a route sweep (workspaces plan 11, T4, U5), on a migrated scratch
 * database through the real app (createApp), with signed session cookies.
 * The route loader opens a request slot around every handler and the
 * session guard fills it; this file reads what the guard did per request.
 *
 *  - an Admin user: every GET of an owner route of brain items reads in the
 *    user's own scope (kind 'user'); nothing answers 500;
 *  - an Admin user with every area switched off: every management route
 *    refuses it (403 reason 'area') before its handler runs;
 *  - a member: every route, every method. Never the system pool (except
 *    the sign-in routes about its own login row); the owner routes refuse it
 *    except the reads opened to every login (MEMBER_OPEN_READS), which run
 *    in its scope; the member routes that read brain items run in its scope
 *    too (W7e), only its own things ('self') hold their own rule; nothing
 *    answers 500;
 *  - no admin screen shows another user's private item: a member's private
 *    workspace item and an item of a workspace the Admin user is not in
 *    appear on no list, search or item route for the Admin user. The W6a
 *    rollback switch (MANTLE_ADMIN_READS=system) shows the pre-W6a answer.
 *  - drafts: an Admin user reads the draft of an item it may edit; a member
 *    never reads a draft on the owner routes.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w6a-route-sweep.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestOutcome } from '@mantle/db';
import { isAnyLoginRoute } from '../lib/auth/any-login-routes';
import { isMemberRoute } from '../lib/auth/member-routes';
import {
  isReadRequest,
  itemWriteTarget,
  memberMayRead,
  memberMayWrite,
  routeClass,
} from '../lib/auth/route-scope';
import { PUBLIC_PATHS } from '../lib/auth-constants';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const seen = vi.hoisted(() => ({
  last: null as unknown,
  reads: [] as readonly string[],
  writes: [] as readonly string[],
}));

// Read what the guard did, inside the request's own slot, once the handler
// is done.
vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...orig,
    runInRequestSlot: <T>(fn: () => T) =>
      orig.runInRequestSlot(async () => {
        try {
          return await fn();
        } finally {
          seen.last = orig.currentRequestOutcome();
          seen.reads = orig.ownRuleSystemReads();
          seen.writes = orig.requestSystemWrites();
        }
      }),
  };
});

/**
 * The writes a request scope sends to the system pool (W6a fix round 1,
 * L2), by login kind, route and calling file (the first outside
 * @mantle/db): the typed writes (insert, update, delete), executeWrite and,
 * since fix round 2 (L-c), each system transaction (withSystemTx and the
 * heads helpers) of a READ request in the login's scope. The system's own
 * bookkeeping only:
 *  - GET /api/activity: journey.ts closes abandoned running traces (the
 *    self-heal before the read);
 *  - GET /api/app-nav: tree/apps-nav.ts moves the pre-tree sidebar layout
 *    and the login's own pins and opens into the tree, once; the apps
 *    kind root (tree/node-ops.ts ensureKindRoot) when it is missing;
 *  - GET /api/docs/reader: files/docs.ts registers the documentation
 *    collection on first read;
 *  - GET /api/files/files: files/ops/shared.ts makes the files root row
 *    when it is missing;
 *  - GET /api/pages/:id: pages/read.ts stores missing block ids, only for a
 *    reader who may edit the page (mayEdit);
 *  - GET /api/tree/:kind (an Admin user and a member): tree/node-ops.ts
 *    makes the kind's root row when the reader does not see one (insert on
 *    conflict do nothing; it returns no row to the reader).
 * The list only shrinks; a new entry needs review.
 */
const REQUEST_SCOPE_SYSTEM_WRITES: ReadonlySet<string> = new Set<string>([
  'admin GET /api/activity update server/web/lib/journey.ts',
  'admin GET /api/app-nav executeWrite packages/content/src/tree/apps-nav.ts',
  'admin GET /api/app-nav withSystemTx packages/content/src/tree/node-ops.ts',
  'admin GET /api/docs/reader insert packages/files/src/docs.ts',
  'admin GET /api/files/files withSystemTx packages/files/src/ops/shared.ts',
  'admin GET /api/pages/:id update packages/content/src/pages/read.ts',
  'admin GET /api/tree/:kind withSystemTx packages/content/src/tree/node-ops.ts',
  'member GET /api/tree/:kind withSystemTx packages/content/src/tree/node-ops.ts',
]);

/** The member entries of that list: a member's read writes nothing else. */
const MEMBER_SCOPE_SYSTEM_WRITES = [
  'member GET /api/tree/:kind withSystemTx packages/content/src/tree/node-ops.ts',
];

/**
 * The reads a member route ('own-rule') sends to the system pool, by route
 * and calling file. Since W7e only the member routes about the login's own
 * things hold their own rule (route-scope.ts classes them 'self': its MCP
 * clients, push devices, the live stream, the old shell): its preferences,
 * its MCP clients and switches, its push devices. The member home reads team
 * items, so it runs in the login's scope (W7e fix round 1, L1). Every member route that reads brain items runs in the
 * login's request scope (W7e), so no member route reads content on the
 * system pool. The list only shrinks, and holds only 'self' routes (tested).
 */
const OWN_RULE_SYSTEM_READS: ReadonlySet<string> = new Set([
  'GET /api/member/mcp packages/content/src/profile-preferences.ts',
  'GET /api/member/mcp packages/tools/src/external-access.ts',
  'GET /api/member/mcp server/web/app/api/member/mcp/route.ts',
  'GET /api/member/mcp server/web/lib/mcp-clients.ts',
  'GET /api/member/push/preferences server/web/lib/push/store.ts',
  'PUT /api/member/push/preferences server/web/lib/push/store.ts',
  'GET /api/member/push/subscriptions server/web/lib/push/store.ts',
]);

type Json = Record<string, unknown>;

/** Whether this box has the app runtime built (the app build reads its
 *  manifest). Without it an app build answers 500 for want of the runtime,
 *  not of the gate: the member sweep, which since the A0 fix round (M3)
 *  runs the build route on a real app, lets that one pass then. */
const APP_RUNTIME_BUILT =
  (process.env.MANTLE_APP_RUNTIME_MANIFEST !== undefined &&
    existsSync(process.env.MANTLE_APP_RUNTIME_MANIFEST)) ||
  existsSync(
    fileURLToPath(new globalThis.URL('../public/app-runtime/manifest.json', import.meta.url)),
  );

/** Streams that never end, and routes that reach outside this box. Their
 *  gate is the same function as their siblings'; they are skipped here. */
const SKIP = [
  /\/stream$/,
  /^\/api\/realtime$/,
  /^\/api\/member\/realtime$/,
  /^\/api\/updates/,
  /^\/api\/mcp(\/|$)/,
  /^\/api\/oauth(\/|$)/,
];

describe.skipIf(!URL)('W6a route sweep: scoped reads for every login', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[] }>;
  let cookieOf: (id: string) => string;
  const owner = randomUUID(); // the anchor, an Admin user
  const noArea = randomUUID(); // an Admin user with every area off
  const mem = randomUUID(); // a member (Team), with a private workspace
  const mem2 = randomUUID(); // a member (Team), alone in "Side"
  const tag = `w6a${randomUUID().slice(0, 6)}`;
  const PASSWORD = 'a long enough password';
  const teamNote = randomUUID();
  const adminNote = randomUUID();
  const sideNote = randomUUID();
  const privNote = randomUUID();
  const teamPage = randomUUID();
  let team = '';
  let side = '';
  let priv = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  const call = async (
    path: string,
    as: string | null,
    method = 'GET',
    body?: unknown,
  ): Promise<{
    status: number;
    text: string;
    outcome: RequestOutcome | null;
    reads: readonly string[];
    writes: readonly string[];
  }> => {
    seen.last = null;
    seen.reads = [];
    seen.writes = [];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (as?.startsWith('mtlk_')) headers.authorization = `Bearer ${as}`;
    else if (as) headers.cookie = cookieOf(as);
    const res = await Promise.race([
      app.request(path, {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
    ]);
    if (!res) return { status: 0, text: 'timeout', outcome: null, reads: [], writes: [] };
    const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
    return {
      status: res.status,
      text,
      outcome: seen.last as RequestOutcome | null,
      reads: seen.reads,
      writes: seen.writes,
    };
  };

  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, via_folder_id = null, excluded = false`);
    });
  };
  const alsoIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${id}, ${ws})
                           on conflict do nothing`);
    });
  };

  /** A concrete path for `pattern`: the Team note or page for an item id,
   *  'notes' for a tree kind, a fresh uuid for anything else. */
  const concrete = (pattern: string, real: boolean): string =>
    pattern
      .split('/')
      .map((seg) => {
        if (seg === '*') return 'x';
        if (!seg.startsWith(':')) return seg;
        if (seg === ':kind') return 'notes';
        if (real && (seg === ':id' || seg === ':nodeId')) {
          return pattern.startsWith('/api/pages') ? teamPage : teamNote;
        }
        return randomUUID();
      })
      .join('/');

  /** The kind of item an open write route names by its `:id`, or null
   *  when it names none (a create, a move by body). */
  const editKindOf = (pattern: string): string | null => {
    if (!pattern.includes('/:id')) return null;
    for (const [prefix, kind] of [
      ['/api/pages/', 'page'],
      ['/api/notes/', 'note'],
      ['/api/draws/', 'draw'],
      ['/api/tables/', 'table'],
      ['/api/apps/', 'app'],
      ['/api/files/files/', 'file'],
      ['/api/files/folders/', 'files-folder'],
      ['/api/tree/:kind/folders/', 'tree-folder'],
      ['/api/tree/items/', 'note'],
    ] as const) {
      if (pattern.startsWith(prefix)) return kind;
    }
    return null;
  };
  let made = 0;
  /** A fresh item of `kind` the member may edit and manage (A0 fix round,
   *  M3): made by the Admin user through its own create route, so every
   *  side row exists, then homed in the member's private workspace. One per
   *  write, so a delete never takes the item of the next. */
  const memberItem = async (kind: string): Promise<string> => {
    made += 1;
    const name = `${tag}-${kind}-${made}`;
    const [path, body, key] = (
      {
        page: ['/api/pages', { title: name }, 'page'],
        note: ['/api/notes', { title: name }, 'note'],
        draw: ['/api/draws', { title: name }, 'draw'],
        table: ['/api/tables', { title: name }, 'table'],
        app: ['/api/apps', { name }, 'app'],
        file: [
          '/api/files/files',
          { parentPath: 'files', filename: `${name}.txt`, content: 'x' },
          'file',
        ],
        'files-folder': ['/api/files/folders', { parentPath: 'files', slug: name }, 'folder'],
        'tree-folder': ['/api/tree/notes/folders', { parentId: null, name }, 'folder'],
      } as Record<string, [string, Json, string]>
    )[kind]!;
    const r = await call(path, owner, 'POST', body);
    expect(r.status, `${kind}: ${r.text.slice(0, 200)}`).toBeLessThan(300);
    const row = (JSON.parse(r.text) as Record<string, Json>)[key]!;
    const id = String(row.id ?? row.nodeId);
    expect(id, `${kind}: ${r.text.slice(0, 200)}`).toMatch(/^[0-9a-f-]{36}$/);
    await homeIn(id, priv);
    return id;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w6a-route-sweep-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    const hash = (await import('bcryptjs')).default.hashSync(PASSWORD, 4);
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${noArea}, ${email('noarea')}, 'x', false, 'admin', 'Nora Noarea'),
      (${mem}, ${email('mem')}, ${hash}, false, 'member', 'Mia Member'),
      (${mem2}, ${email('mem2')}, 'x', false, 'member', 'Max Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, bridge_key as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    const admin = ws.find((w) => w.key === 'admin')!.id;
    await x(
      sql`update workspace_users set limits = ${JSON.stringify({
        areas: { settings: false, users: false, assistants: false, connectors: false, keys: false },
      })}::jsonb where workspace_id = ${admin} and login_id = ${noArea}`,
    );
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    manifest = (await import('./route-manifest.gen')).routeManifest;
    // Two workspaces through the real routes: Side (mem2 only) and the
    // member's private one (mem only).
    side = JSON.parse((await call('/api/workspaces', mem2, 'POST', { name: 'Side' })).text).id;
    priv = JSON.parse(
      (await call('/api/workspaces', mem, 'POST', { name: 'Mia private' })).text,
    ).id;
    expect(side && priv).toBeTruthy();
    // The items (made on the system pool, homed in Admin by the trigger).
    for (const [id, title] of [
      [teamNote, `${tag} team note`],
      [adminNote, `${tag} admin note`],
      [sideNote, `${tag} side note`],
      [privNote, `${tag} private note`],
    ] as const) {
      await x(sql`insert into nodes (id, owner_id, type, title, path)
                  values (${id}, ${owner}, 'note', ${title}, 'notes')`);
    }
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${teamPage}, ${owner}, 'page', ${`${tag} team page`}, 'pages')`);
    await x(sql`insert into pages (node_id, doc, draft_doc, draft_rev, draft_updated_at)
                values (${teamPage}, '{"type":"doc","content":[]}'::jsonb,
                        '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, 1, now())`);
    await alsoIn(teamNote, team);
    await alsoIn(teamPage, team);
    await homeIn(sideNote, side);
    await homeIn(privNote, priv);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  const skipped = (pattern: string) => SKIP.some((re) => re.test(pattern));
  /** The request-scope writes the sweeps saw (L2), checked at the end. */
  const scopeWrites = new Set<string>();
  const noteWrites = (who: 'admin' | 'member', key: string, writes: readonly string[]) => {
    for (const w of writes) {
      const file = w.replace(/^\S+ /, '').replace(/^.*?((packages|server)\/)/, '$1');
      scopeWrites.add(`${who} ${key} ${w.split(' ')[0]} ${file}`);
    }
  };
  const isPublic = (pattern: string) =>
    PUBLIC_PATHS.some((p) => pattern === p || pattern.startsWith(`${p}/`));
  const isOwnerRoute = (method: string, pattern: string) =>
    pattern.startsWith('/api/') &&
    !isPublic(pattern) &&
    !isMemberRoute(method, pattern) &&
    !pattern.startsWith('/api/client/') &&
    !isAnyLoginRoute(method, pattern) &&
    routeClass(pattern) !== null;

  it('an Admin user: every read of brain items runs in its scope, none answers 500', async () => {
    const failures: string[] = [];
    let scoped = 0;
    for (const e of manifest) {
      if (skipped(e.pattern) || !e.methods.includes('GET')) continue;
      const cls = routeClass(e.pattern);
      const anyLogin = isAnyLoginRoute('GET', e.pattern);
      if (!anyLogin && cls?.kind !== 'content') continue;
      if (isMemberRoute('GET', e.pattern) || e.pattern.startsWith('/api/client/')) continue;
      const r = await call(concrete(e.pattern, true), owner);
      const key = `GET ${e.pattern}`;
      noteWrites('admin', key, r.writes);
      if (r.status >= 500 || r.status === 0)
        failures.push(`${key} ${r.status} ${r.text.slice(0, 160)}`);
      else if (r.status !== 401 && r.status !== 403 && r.outcome?.kind !== 'user') {
        failures.push(`${key} ran as ${JSON.stringify(r.outcome)}`);
      } else scoped += 1;
    }
    expect(failures).toEqual([]);
    expect(scoped).toBeGreaterThan(60);
  }, 600_000);

  it('an Admin user without an area: every management route refuses it before its handler', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const e of manifest) {
      const cls = routeClass(e.pattern);
      if (cls?.kind !== 'area' || skipped(e.pattern)) continue;
      for (const method of e.methods) {
        if (method === 'OPTIONS' || !isOwnerRoute(method, e.pattern)) continue;
        const r = await call(concrete(e.pattern, false), noArea, method);
        checked += 1;
        const body = (() => {
          try {
            return JSON.parse(r.text) as Json;
          } catch {
            return {};
          }
        })();
        if (r.status !== 403 || body.reason !== 'area' || r.outcome?.kind === 'system') {
          failures.push(`${method} ${e.pattern} ${r.status} ${r.text.slice(0, 120)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  }, 600_000);

  it('a member: never the system pool, owner routes refused but the open reads, none answers 500', async () => {
    const failures: string[] = [];
    let opened = 0;
    let openWrites = 0;
    let onItem = 0;
    let ownRule = 0;
    const systemReads = new Set<string>();
    for (const e of manifest) {
      if (!e.pattern.startsWith('/api/') || skipped(e.pattern)) continue;
      for (const method of e.methods) {
        if (method === 'OPTIONS') continue;
        const read = method === 'GET';
        // An open write on an item runs on one the member may edit, so the
        // handler runs and the scope check below covers it (M3). The
        // random-id 404 is its own pass, after this one.
        const openOnItem =
          isOwnerRoute(method, e.pattern) &&
          !memberMayRead(method, e.pattern) &&
          memberMayWrite(method, e.pattern) &&
          editKindOf(e.pattern) !== null;
        const path = openOnItem
          ? (() => {
              const kind = editKindOf(e.pattern)!;
              return memberItem(kind).then((id) =>
                e.pattern
                  .split('/')
                  .map((seg) => (seg === ':id' ? id : seg === ':kind' ? 'notes' : seg))
                  .join('/'),
              );
            })()
          : Promise.resolve(concrete(e.pattern, read));
        const r = await call(await path, mem, method);
        const key = `${method} ${e.pattern}`;
        noteWrites('member', key, r.writes);
        if (r.status >= 500 || r.status === 0) {
          if (!(key === 'POST /api/apps/:id/build' && !APP_RUNTIME_BUILT && r.status === 500)) {
            failures.push(`${key} ${r.status} ${r.text.slice(0, 160)}`);
          }
          continue;
        }
        if (r.outcome?.kind === 'system' && r.outcome.why !== 'login-self') {
          failures.push(`${key} ran on the system pool (${r.outcome.why})`);
        }
        // The client portal stubs (410 to any login since W8a) run the
        // any-login gate first, which notes the request as login-self.
        if (
          r.outcome?.kind === 'system' &&
          !e.pattern.startsWith('/api/auth/') &&
          !e.pattern.startsWith('/api/client/')
        ) {
          failures.push(`${key} ran as login-self outside /api/auth`);
        }
        // A member route holds its own rule (withViewer per read, W5b2).
        if (r.outcome?.kind === 'own-rule' && !isMemberRoute(method, e.pattern)) {
          failures.push(`${key} ran by its own rule outside the member routes`);
        }
        // W7e: only a member route about the login's own things holds its
        // own rule; one that reads brain items runs in the login's scope.
        if (r.outcome?.kind === 'own-rule' && routeClass(e.pattern)?.kind !== 'self') {
          failures.push(`${key} ran by its own rule, not in the login's scope`);
        }
        if (
          isMemberRoute(method, e.pattern) &&
          routeClass(e.pattern)?.kind === 'content' &&
          r.status !== 401 &&
          r.outcome?.kind !== 'user'
        ) {
          failures.push(`${key} member content route ran as ${JSON.stringify(r.outcome)}`);
        }
        if (r.outcome?.kind === 'own-rule') {
          ownRule += 1;
          for (const read of r.reads) {
            const file = read.replace(/^\S+ /, '').replace(/^.*?((packages|server)\/)/, '$1');
            systemReads.add(`${key} ${file}`);
          }
        }
        if (isOwnerRoute(method, e.pattern)) {
          if (memberMayRead(method, e.pattern)) {
            opened += 1;
            if (r.status === 403 || r.outcome?.kind !== 'user') {
              failures.push(`${key} open read: ${r.status} ${JSON.stringify(r.outcome)}`);
            }
          } else if (openOnItem) {
            // An open write on an item the member may edit: the gate lets it
            // through and the handler runs in the member's scope (M3).
            openWrites += 1;
            onItem += 1;
            if (r.outcome?.kind !== 'user' || r.text.includes('"item-workspace"')) {
              failures.push(`${key} open write on its item: ${r.status} ${r.text.slice(0, 120)}`);
            }
          } else if (memberMayWrite(method, e.pattern)) {
            // W6b: an open write with no item runs in the member's scope, or
            // is refused by the workspace check, never by member-login and
            // never on the system pool.
            openWrites += 1;
            const checked =
              (r.status === 403 &&
                (r.text.includes('"item-workspace"') || r.text.includes('"workspace"'))) ||
              (r.status === 404 && r.text === '{"ok":false,"error":"not found"}');
            if (r.text.includes('member-login') || (!checked && r.outcome?.kind !== 'user')) {
              failures.push(`${key} open write: ${r.status} ${JSON.stringify(r.outcome)}`);
            }
          } else if (r.status !== 403 && r.status !== 401) {
            // 403 from the session gates, 401 from the byte routes' asset
            // gate and the ticket-gated frame.
            failures.push(`${key} not refused: ${r.status}`);
          }
        }
      }
    }
    // A member route reads the system pool only by its own rule, and only
    // where it did when W6a shipped.
    expect([...systemReads].filter((r) => !OWN_RULE_SYSTEM_READS.has(r))).toEqual([]);
    // The own-rule list holds only 'self' routes (W7e).
    for (const entry of OWN_RULE_SYSTEM_READS) {
      expect(routeClass(entry.split(' ')[1]!), entry).toEqual({ kind: 'self' });
    }
    expect(ownRule).toBeGreaterThanOrEqual(8);
    expect(failures).toEqual([]);
    expect(opened).toBeGreaterThan(20);
    expect(openWrites).toBeGreaterThan(30);
    expect(onItem).toBeGreaterThan(25);
  }, 900_000);

  it('a member: an open write on an id it cannot read, or no row has, is the gate’s one 404', async () => {
    // The other half of M3: the same routes on a random id, and on an item
    // homed where the member is not, answer the same 404 before any handler.
    const failures: string[] = [];
    let checked = 0;
    for (const e of manifest) {
      if (!e.pattern.startsWith('/api/') || skipped(e.pattern)) continue;
      for (const method of e.methods) {
        if (
          !isOwnerRoute(method, e.pattern) ||
          memberMayRead(method, e.pattern) ||
          !memberMayWrite(method, e.pattern) ||
          editKindOf(e.pattern) === null
        ) {
          continue;
        }
        for (const id of [randomUUID(), sideNote]) {
          const path = e.pattern
            .split('/')
            .map((seg) => (seg === ':id' ? id : seg === ':kind' ? 'notes' : seg))
            .join('/');
          const r = await call(path, mem, method);
          checked += 1;
          if (
            r.status !== 404 ||
            r.text !== '{"ok":false,"error":"not found"}' ||
            r.outcome?.kind === 'user'
          ) {
            failures.push(
              `${method} ${e.pattern} (${id === sideNote ? 'unread' : 'no row'}) ${r.status} ${r.text.slice(0, 120)}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(50);
  }, 600_000);

  it('a member API key (U5): /api/v1 answers whoami in its scope and refuses the rest', async () => {
    const made = await call('/api/access-keys', mem, 'POST', {
      name: 'U5',
      access: 'read_write',
      areas: null,
      password: PASSWORD,
    });
    expect(made.status, made.text).toBe(201);
    const secret = (JSON.parse(made.text) as { secret: string }).secret;
    const failures: string[] = [];
    let checked = 0;
    for (const e of manifest) {
      if (!e.pattern.startsWith('/api/v1/')) continue;
      for (const method of e.methods) {
        if (method === 'OPTIONS') continue;
        const r = await call(concrete(e.pattern, method === 'GET'), secret, method);
        checked += 1;
        const key = `${method} ${e.pattern}`;
        if (r.outcome?.kind === 'system') failures.push(`${key} ran on the system pool`);
        if (key === 'GET /api/v1/whoami') {
          if (r.status !== 200 || r.outcome?.kind !== 'user') failures.push(`${key} ${r.status}`);
        } else if (r.status !== 403 && r.status !== 401 && r.status !== 404) {
          failures.push(`${key} not refused: ${r.status}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(10);
  }, 300_000);

  it('no admin screen shows another user’s private item (nor an item of a workspace it is not in)', async () => {
    const hidden = [privNote, sideNote, `${tag} private note`, `${tag} side note`];
    const lists = [
      '/api/notes',
      '/api/pages',
      '/api/tree/notes',
      `/api/tree/notes/search?q=${tag}`,
      `/api/search?q=${tag}`,
      `/api/mentions/search?q=${tag}`,
      '/api/apps',
      '/api/tables',
      '/api/draws',
      '/api/files/files',
      '/api/tasks',
      '/api/activity',
      '/api/dashboard',
    ];
    const leaks: string[] = [];
    let sawTeam = false;
    for (const path of lists) {
      const r = await call(path, owner);
      expect(r.status, `${path} ${r.text.slice(0, 200)}`).toBeLessThan(500);
      for (const h of hidden) if (r.text.includes(h)) leaks.push(`${path} shows ${h}`);
      if (r.text.includes(teamNote)) sawTeam = true;
    }
    for (const id of [privNote, sideNote]) {
      for (const path of [`/api/nodes/${id}`, `/api/notes/${id}`, `/api/grants/${id}`]) {
        const r = await call(path, owner);
        if (r.status !== 404) leaks.push(`${path} answers ${r.status}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(sawTeam).toBe(true);
    // Each item's own user reads it; the other member does not.
    expect((await call(`/api/notes/${privNote}`, mem)).status).toBe(200);
    expect((await call(`/api/notes/${sideNote}`, mem2)).status).toBe(200);
    expect((await call(`/api/notes/${sideNote}`, mem)).status).toBe(404);
    expect((await call(`/api/notes/${adminNote}`, mem)).status).toBe(404);
    expect((await call(`/api/notes/${adminNote}`, owner)).status).toBe(200);
  }, 300_000);

  it('the rollback switch puts Admin reads back on the system pool (the pre-W6a answer)', async () => {
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const r = await call(`/api/notes/${privNote}`, owner);
      expect(r.status).toBe(200);
      expect(r.outcome).toEqual({ kind: 'system', why: 'admin-reads-flag' });
      // Members stay scoped whatever it says.
      const mr = await call(`/api/notes/${sideNote}`, mem);
      expect(mr.status).toBe(404);
      expect(mr.outcome?.kind).toBe('user');
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
    expect((await call(`/api/notes/${privNote}`, owner)).status).toBe(404);
  });

  it('an Admin user writes no item homed in a workspace it is not in (S1: add yourself first)', async () => {
    // Every owner write route that names an item: the private and the Side
    // item are refused before the handler runs (nothing is written).
    const failures: string[] = [];
    let checked = 0;
    for (const e of manifest) {
      if (skipped(e.pattern)) continue;
      for (const method of e.methods) {
        if (method === 'OPTIONS' || isReadRequest(method, e.pattern)) continue;
        if (!isOwnerRoute(method, e.pattern)) continue;
        if (routeClass(e.pattern)?.kind !== 'content') continue;
        const probe = concrete(e.pattern, false);
        // Routes whose id names another row (a share, a revision, a
        // deleted app) are checked in w6a-fix-sweep.db.test.ts.
        if (itemWriteTarget(method, e.pattern, probe)?.ref !== 'node') continue;
        for (const id of [privNote, sideNote]) {
          const parts = probe.split('/');
          parts[e.pattern.split('/').indexOf(':id')] = id;
          const path = parts.join('/');
          const r = await call(path, owner, method);
          checked += 1;
          if (r.status !== 403 || !r.text.includes('"item-workspace"')) {
            failures.push(`${method} ${e.pattern} ${r.status} ${r.text.slice(0, 120)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(60);
    // An item of its own workspaces it still writes, and an id no row has
    // gets the handler's answer.
    const ok = await call(`/api/notes/${adminNote}`, owner, 'PATCH', {
      title: `${tag} admin note`,
    });
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    const none = await call(`/api/notes/${randomUUID()}`, owner, 'PATCH', { title: 'x' });
    expect(none.text).not.toContain('item-workspace');
    // The member that holds the private workspace (its Moderator) writes its
    // own item through the owner route since W6b.
    expect((await call(`/api/notes/${privNote}`, mem, 'PATCH', { title: 'x' })).status).toBe(200);
    // The rollback switch restores only the reads (W7 integration fix 2,
    // M6): the item write check stays on under it.
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const r = await call(`/api/notes/${privNote}`, owner, 'PATCH', {});
      expect(r.text).toContain('item-workspace');
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
  }, 600_000);

  it('L2: the system-pool writes of request scopes are the pinned list', () => {
    // Runs after the Admin and member sweeps above (same file, in order).
    expect([...scopeWrites].filter((w) => !REQUEST_SCOPE_SYSTEM_WRITES.has(w)).sort()).toEqual([]);
    expect([...scopeWrites].filter((w) => w.startsWith('member ')).sort()).toEqual(
      MEMBER_SCOPE_SYSTEM_WRITES,
    );
  });

  it('drafts: an Admin user reads the draft of an item it may edit, a member none', async () => {
    const a = JSON.parse((await call(`/api/pages/${teamPage}`, owner)).text) as Json;
    const b = JSON.parse((await call(`/api/pages/${teamPage}`, mem)).text) as Json;
    expect(JSON.stringify(a)).toContain('paragraph');
    expect(JSON.stringify(b)).not.toContain('paragraph');
  });
});
