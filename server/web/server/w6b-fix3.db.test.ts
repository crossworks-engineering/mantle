/**
 * Workspaces W6b fix round 3, through the real app (createApp) on a migrated
 * scratch database with signed session cookies, through the MCP surface and
 * through the libraries the routes call:
 *
 *  - M-1: only the brain owner links a brain that acts as the owner (or
 *    names risky tools on one, arms one, or mints its token); another Admin
 *    user gets 403. An app_delete through a peer is the owner's (purged
 *    after 30 days) only when the peer acts as the owner and the owner made
 *    it; any other peer's is held;
 *  - L-1: a page or folder link never serves a snapshot copy: its served
 *    list refuses one and offers none, and one already on a list is dropped
 *    when the link is served;
 *  - L-2: a pending app_delete approved runs naming its approver: the
 *    owner's is purged after 30 days, another Admin user's held;
 *  - L-3: a copy's create that races to a row another create made refuses
 *    (a taken name, 409) and leaves that row as it was.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w6b-fix3.db.test.ts
 */
import { randomUUID, createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('W6b fix round 3', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let c: typeof import('@mantle/content');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // a second Admin user, not the owner
  const mem = randomUUID(); // a member
  const mem2 = randomUUID(); // another member
  const tag = `w6bh${randomUUID().slice(0, 6)}`;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;
  const call = async (
    p: string,
    as: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; text: string; json: Json }> => {
    const res = await app.request(p, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieOf(as) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      /* not json */
    }
    return { status: res.status, text, json };
  };
  const rowOf = async (id: string) =>
    (
      await x<{ home: string | null; r: string[]; w: string[]; data: Json }>(sql`
        select home_ws::text as home, read_ws::text[] as r, write_ws::text[] as w, data
          from nodes where id = ${id}`)
    )[0];
  const privateFor = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select "public"."mantle_ws_private_workspace"(${login}::uuid)::text as ws`,
      )
    )[0]!.ws;
  const idOf = (r: { json: Json }, key: string) =>
    ((r.json[key] as Json | undefined)?.id ?? r.json.id) as string;
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const stampOf = (of: string) => ({
    snapshot_of: of,
    extract_skipped: { reason: 'snapshot_copy', at: new Date().toISOString() },
  });
  const makeCopy = <T>(home: string, of: string, fn: () => Promise<T>) =>
    sys(() =>
      m.withCreateHome({ createWs: home, privateWs: null, quiet: true, stamp: stampOf(of) }, fn),
    );
  const makeIn = <T>(home: string, fn: () => Promise<T>) =>
    sys(() => m.withCreateHome({ createWs: home, privateWs: null, quiet: true }, fn));

  // app_delete's record: held for the owner, and by whom.
  const newApp = async (n: string) =>
    idOf(await call('/api/apps', owner, 'POST', { name: `${tag} ${n}` }), 'app');
  const meta = async (id: string) =>
    (
      await x<{ held: boolean | null; by: string | null }>(sql`
        select (code->'meta'->>'keepForOwner')::boolean as held, code->'meta'->>'deletedBy' as by
          from node_snapshots where node_id = ${id} and trigger = 'pre_delete'
         order by seq desc limit 1`)
    )[0];
  const snapshotsLeft = async (id: string) =>
    Number(
      (
        await x<{ n: number }>(
          sql`select count(*)::int as n from node_snapshots where node_id = ${id}`,
        )
      )[0]!.n,
    );
  const purgeLater = async () => {
    const trash = await import('@mantle/content/app-trash');
    await sys(() => trash.purgeExpiredDeletedApps({ now: new Date(Date.now() + 31 * 86_400_000) }));
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w6b-fix3-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w6b-fix3-secret-at-least-32-characters!!';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    c = await import('@mantle/content');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Ada Admin'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email('mem2')}, 'x', false, 'member', 'Max Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    await m.asSystem(() => f.ensureFilesRootBranch(owner), 'test');
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('M-1: only the owner links a brain that acts as the owner; a peer’s app_delete is the owner’s only when the owner made it', async () => {
    const peerBody = (n: string, extra: Json = {}) => ({
      displayName: `${tag} peer ${n}`,
      baseUrl: 'https://peer.example.invalid',
      ...extra,
    });
    const createdBy = async (id: string) =>
      (
        await x<{ by: string | null }>(sql`select created_by::text as by from mantle_peers
                                            where id = ${id}`)
      )[0]!.by;

    // Another Admin user: no owner peer, no risky tools.
    let r = await call('/api/peers', admin2, 'POST', peerBody('a', { actsAs: 'owner' }));
    expect(r.status, r.text.slice(0, 200)).toBe(403);
    r = await call(
      '/api/peers',
      admin2,
      'POST',
      peerBody('b', { actsAs: mem, allowedRiskyTools: ['app_delete'] }),
    );
    expect(r.status, r.text.slice(0, 200)).toBe(403);
    // A member peer it may link; it is recorded as its maker.
    r = await call('/api/peers', admin2, 'POST', peerBody('c', { actsAs: mem }));
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const memPeer = idOf(r, 'peer');
    expect(await createdBy(memPeer)).toBe(admin2);
    // Nor may it turn its own peer into the owner's.
    r = await call(`/api/peers/${memPeer}`, admin2, 'PATCH', { actsAs: 'owner' });
    expect(r.status, r.text.slice(0, 200)).toBe(403);

    // The owner links its own, armed with app_delete.
    const armed = { actsAs: 'owner', writeEnabled: true, allowedRiskyTools: ['app_delete'] };
    r = await call('/api/peers', owner, 'POST', peerBody('o', armed));
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const ownPeer = idOf(r, 'peer');
    const ownToken = r.json.inboundToken as string;
    expect(await createdBy(ownPeer)).toBe(owner);
    // The other Admin user may not arm, disarm or re-key the owner's peer.
    for (const [p, method, body] of [
      [`/api/peers/${ownPeer}`, 'PATCH', { writeEnabled: false }],
      [`/api/peers/${ownPeer}`, 'PATCH', { allowedRiskyTools: [] }],
      [`/api/peers/${ownPeer}/rotate`, 'POST', {}],
    ] as const) {
      const res = await call(p, admin2, method, body);
      expect(res.status, `${method} ${p} ${res.text.slice(0, 200)}`).toBe(403);
    }

    // The owner binds the other Admin user's peer to itself: made its own
    // and re-keyed since fix round 4 (L-1). One bound to the owner before
    // that, still made by that user: its app_delete is held.
    r = await call(`/api/peers/${memPeer}`, owner, 'PATCH', armed);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(await createdBy(memPeer)).toBe(owner);
    const memToken = (r.json.inboundToken ?? '') as string;
    expect(memToken).not.toBe('');
    await x(sql`update mantle_peers set created_by = ${admin2}::uuid where id = ${memPeer}`);

    // A peer made before its maker was recorded, bound to the owner.
    r = await call('/api/peers', owner, 'POST', peerBody('legacy', armed));
    const legacyPeer = idOf(r, 'peer');
    const legacyToken = r.json.inboundToken as string;
    await x(sql`update mantle_peers set created_by = null where id = ${legacyPeer}`);

    // app_delete through each peer, over MCP as /api/mcp resolves it.
    const auth = await import('../lib/mcp-auth');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const ls = await import('@mantle/mcp-core');
    const viaPeer = async (token: string, id: string) => {
      const caller = await auth.resolveMcpCaller(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(caller).toMatchObject({ via: 'peer', role: 'admin', loginId: owner });
      const server = new McpServer({ name: 'test', version: '0' });
      ls.registerPreparedTools(server, await ls.prepareCallerTools(caller!));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0' });
      await Promise.all([server.connect(a), client.connect(b)]);
      const res = (await client.callTool({ name: 'app_delete', arguments: { id } })) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      expect(res.isError, JSON.stringify(res.content).slice(0, 200)).toBeFalsy();
      await client.close();
      return caller!;
    };
    const p1 = await newApp('peer owner');
    expect((await viaPeer(ownToken, p1)).peerByOwner).toBe(true);
    expect((await meta(p1))!.held).toBeNull();
    const p2 = await newApp('peer admin2');
    expect((await viaPeer(memToken, p2)).peerByOwner).toBe(false);
    expect(await meta(p2)).toEqual({ held: true, by: null });
    const p3 = await newApp('peer legacy');
    expect((await viaPeer(legacyToken, p3)).peerByOwner).toBe(false);
    expect(await meta(p3)).toEqual({ held: true, by: null });
    // The owner binding the legacy peer again records itself as its maker
    // (and re-keys it, fix round 4, L-1).
    r = await call(`/api/peers/${legacyPeer}`, owner, 'PATCH', armed);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(await createdBy(legacyPeer)).toBe(owner);
    const p4 = await newApp('peer adopted');
    expect((await viaPeer(r.json.inboundToken as string, p4)).peerByOwner).toBe(true);
    expect((await meta(p4))!.held).toBeNull();

    await purgeLater();
    for (const id of [p1, p4]) expect(await snapshotsLeft(id)).toBe(0);
    for (const id of [p2, p3]) expect(await snapshotsLeft(id)).toBeGreaterThan(0);
  });

  it('L-1: a page or folder link never serves a snapshot copy', async () => {
    const priv = await privateFor(mem);
    const copy = await makeCopy(priv, randomUUID(), () =>
      c.createPage(owner, { title: `${tag} served copy` }),
    );
    const plain = await makeIn(priv, () => c.createPage(owner, { title: `${tag} served plain` }));
    const page = await makeIn(priv, () => c.createPage(owner, { title: `${tag} the link page` }));
    const [root] = await x<{ id: string; path: string }>(sql`
      select id::text as id, path::text as path from nodes
       where owner_id = ${owner} and type = 'branch' and path = 'pages'`);
    expect(root).toBeTruthy();
    const pageItem = { id: page.id, type: 'page', path: null };
    const folderItem = { id: root!.id, type: 'branch', path: root!.path };

    // Its author reads and moderates the copy, and still may not serve it.
    for (const item of [pageItem, folderItem]) {
      await expect(c.checkServeList(owner, mem, item, [copy.id])).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    }
    // One a list holds already is dropped from it, the rest kept.
    expect(
      await c.checkServeList(owner, mem, folderItem, [copy.id, plain.id], [copy.id, plain.id]),
    ).toEqual([plain.id.toLowerCase()]);
    // The folder link's offer: the plain page, never the copy.
    const offered = (await c.listServeCandidates(owner, mem, folderItem)).map((o) => o.nodeId);
    expect(offered).toContain(plain.id);
    expect(offered).not.toContain(copy.id);

    // Served: a list made before the rule still holds the copy; the link
    // drops it when served.
    const shares = await import('../lib/shares');
    const linkOn = async (nodeId: string, nodeType: string) => {
      const [s] = await x<{ id: string }>(sql`
        insert into shares (token, owner_id, node_id, node_type, settings)
        values (${randomUUID()}, ${owner}, ${nodeId}, ${nodeType}::node_type,
                ${JSON.stringify({ served: [copy.id, plain.id] })}::jsonb)
        returning id::text as id`);
      const [row] = await m.systemDb.select().from(m.shares).where(eq(m.shares.id, s!.id));
      return row!;
    };
    const pageLink = await linkOn(page.id, 'page');
    const folderLink = await linkOn(root!.id, 'branch');
    for (const link of [pageLink, folderLink]) {
      expect(await shares.isServed(link, copy.id)).toBe(false);
      expect(await shares.isServed(link, plain.id)).toBe(true);
      const live = await shares.liveServedIds(link);
      expect(live.has(copy.id.toLowerCase())).toBe(false);
      expect(live.has(plain.id.toLowerCase())).toBe(true);
    }
    const view = await shares.loadShareView(folderLink);
    expect(view?.kind).toBe('folder');
    const served = (view as { served: string[] }).served;
    expect(served).toContain(plain.id.toLowerCase());
    expect(served).not.toContain(copy.id.toLowerCase());
  });

  it('L-2: a pending app_delete approved names its approver: the owner’s is purged, another Admin user’s held', async () => {
    await x(sql`insert into tools (owner_id, slug, name, description, handler, requires_confirm)
      values (${owner}, 'app_delete', 'Delete a mini app', 'Delete a mini app by id.',
              '{"kind":"builtin","ref":"app_delete"}'::jsonb, true)
      on conflict do nothing`);
    // Queued for the login that approves it: a login other than the anchor
    // decides only its own pending calls (W7 integration fix 2).
    const queue = async (appId: string, login: string) =>
      (
        await x<{
          id: string;
        }>(sql`insert into pending_tool_calls (owner_id, tool_slug, args, login_id)
          values (${owner}, 'app_delete', ${JSON.stringify({ id: appId })}::jsonb, ${login})
          returning id::text as id`)
      )[0]!.id;
    const approve = async (as: string, pendingId: string) => {
      const r = await call(`/api/pending/${pendingId}`, as, 'PATCH', { decision: 'approve' });
      expect(r.status, r.text.slice(0, 300)).toBe(200);
      const p = r.json.pending as Json;
      expect(p.error ?? null, JSON.stringify(p).slice(0, 300)).toBeNull();
    };
    const a1 = await newApp('pending owner');
    await approve(owner, await queue(a1, owner));
    expect((await meta(a1))!.held).toBeNull();
    const a2 = await newApp('pending admin2');
    await approve(admin2, await queue(a2, admin2));
    expect(await meta(a2)).toEqual({ held: true, by: admin2 });

    await purgeLater();
    expect(await snapshotsLeft(a1)).toBe(0);
    expect(await snapshotsLeft(a2)).toBeGreaterThan(0);
  });

  it('L-3: a copy’s create that races to another create’s row refuses and leaves it be', async () => {
    const priv = await privateFor(mem);
    const other = await privateFor(mem2);
    const name = 'raced-other.txt';
    const disk = f.diskPathForFile('files', name)!;
    const otherRow = randomUUID();
    let upsert: Promise<unknown> | undefined;
    let failure: unknown;
    // Another create's row (homed in the workspace its create named), in a
    // transaction held open while the copy's create reaches its insert.
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('mantle.create_ws', ${other}, true)`);
      await tx.execute(sql`insert into nodes (id, owner_id, type, title, slug, path, data, tags)
        values (${otherRow}, ${owner}, 'file', ${name}, ${name}, 'files', ${JSON.stringify({
          filename: name,
          extension: 'txt',
          mime_type: 'text/plain',
          size_bytes: 5,
          sha256: sha('OTHER'),
          content: 'OTHER',
        })}::jsonb, '{file}')`);
      upsert = makeCopy(priv, randomUUID(), () =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: name,
          bytes: Buffer.from('COPY'),
        }),
      ).catch((e: unknown) => {
        failure = e;
      });
      for (let i = 0; i < 200; i++) {
        if (
          await access(disk).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 300));
    });
    await upsert;
    // Refused as a taken name (the routes answer it 409).
    expect(failure).toBeInstanceOf(f.FileNameTakenError);
    expect(String((failure as Error).message)).toMatch(/already exists/);
    // The other create's row is as it made it: not a copy, its own home.
    const row = (await rowOf(otherRow))!;
    expect(row.home).toBe(other);
    expect(row.data.snapshot_of).toBeUndefined();
    expect(row.data.sha256).toBe(sha('OTHER'));
  });
});
