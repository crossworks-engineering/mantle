/**
 * Workspaces W6b fix round 4, through the real app (createApp) on a migrated
 * scratch database with signed session cookies, and through the libraries
 * the routes call:
 *
 *  - L-1: the owner binding to itself a peer another Admin user made re-keys
 *    it in the same request (the maker saw the old token) and records the
 *    owner as its maker; since fix round 5 (M-1) a peer the owner made is
 *    re-keyed too as it moves into the owner's binding, and keeps its token
 *    once it is bound to the owner;
 *  - L-2: a copy's create that races to a row holding other bytes refuses
 *    (a taken name, 409) and leaves that row as it was;
 *  - L-4: another Admin user's change the owner alone makes on a peer bound
 *    to the owner, racing the owner's bind, lands nowhere (403).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w6b-fix4.db.test.ts
 */
import { randomUUID, createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('W6b fix round 4', () => {
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
  const tag = `w6bi${randomUUID().slice(0, 6)}`;

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
  const privateFor = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${login}, true)::uuid)::text as ws`,
      )
    )[0]!.ws;
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const makeCopy = <T>(home: string, of: string, fn: () => Promise<T>) =>
    sys(() =>
      m.withCreateHome(
        {
          createWs: home,
          privateWs: null,
          quiet: true,
          stamp: {
            snapshot_of: of,
            extract_skipped: { reason: 'snapshot_copy', at: new Date().toISOString() },
          },
        },
        fn,
      ),
    );
  const peerBody = (n: string, extra: Json = {}) => ({
    displayName: `${tag} peer ${n}`,
    baseUrl: 'https://peer.example.invalid',
    ...extra,
  });
  const peerRow = async (id: string) =>
    (
      await x<{ by: string | null; acts: string | null; write: boolean; hash: string }>(sql`
        select created_by::text as by, acts_as_login_id::text as acts, write_enabled as write,
               inbound_token_hash as hash
          from mantle_peers where id = ${id}`)
    )[0]!;
  const authenticates = async (token: string) => (await c.verifyInboundToken(token)) !== null;
  /** Holds a row lock on the peer, bound to the owner but not committed,
   *  while `during` starts a request; commits, then awaits that request. */
  const ownerBindsDuring = async <T>(peerId: string, during: () => Promise<T>): Promise<T> => {
    let pending: Promise<T> | undefined;
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sql`update mantle_peers
                              set acts_as_login_id = ${owner}::uuid,
                                  write_enabled = false, allowed_risky_tools = '{}'
                            where id = ${peerId}`);
      pending = during();
      // Its check (a plain read) passes; its write waits on this row.
      await new Promise((r) => setTimeout(r, 700));
    });
    return pending!;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w6b-fix4-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w6b-fix4-secret-at-least-32-characters!!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    c = await import('@mantle/content');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Ada Admin'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Mia Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
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
  }, 60_000);

  it('L-1: the owner binding a peer another Admin user made re-keys it; its own bound one keeps its token', async () => {
    // Another Admin user makes a member peer: it saw that peer's token.
    let r = await call('/api/peers', admin2, 'POST', peerBody('a', { actsAs: mem }));
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const theirs = (r.json.peer as Json).id as string;
    const seen = r.json.inboundToken as string;
    expect(await authenticates(seen)).toBe(true);
    expect((await peerRow(theirs)).by).toBe(admin2);

    // The owner binds it to itself: a new token in the same request.
    r = await call(`/api/peers/${theirs}`, owner, 'PATCH', { actsAs: 'owner' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const fresh = r.json.inboundToken as string;
    expect(typeof fresh).toBe('string');
    expect(fresh).not.toBe(seen);
    expect(await authenticates(seen)).toBe(false);
    expect(await authenticates(fresh)).toBe(true);
    expect(await peerRow(theirs)).toMatchObject({ by: owner, acts: owner });
    // Bound again by the owner, now its maker: no new token.
    r = await call(`/api/peers/${theirs}`, owner, 'PATCH', { actsAs: 'owner' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.json.inboundToken).toBeUndefined();
    expect(await authenticates(fresh)).toBe(true);

    // A peer made before its maker was recorded is re-keyed the same way.
    r = await call('/api/peers', owner, 'POST', peerBody('legacy'));
    const legacy = (r.json.peer as Json).id as string;
    const legacyToken = r.json.inboundToken as string;
    await x(sql`update mantle_peers set created_by = null where id = ${legacy}`);
    r = await call(`/api/peers/${legacy}`, owner, 'PATCH', { actsAs: 'owner' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(await authenticates(legacyToken)).toBe(false);
    expect(await authenticates(r.json.inboundToken as string)).toBe(true);
    expect((await peerRow(legacy)).by).toBe(owner);

    // A peer the owner made, moving into the owner's binding, is re-keyed
    // too (fix round 5, M-1): another Admin user may have rotated it while
    // it was bound to the member.
    r = await call('/api/peers', owner, 'POST', peerBody('own', { actsAs: mem }));
    const own = (r.json.peer as Json).id as string;
    const ownToken = r.json.inboundToken as string;
    const before = (await peerRow(own)).hash;
    r = await call(`/api/peers/${own}`, owner, 'PATCH', { actsAs: 'owner', writeEnabled: true });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const ownFresh = r.json.inboundToken as string;
    expect(typeof ownFresh).toBe('string');
    expect(await authenticates(ownToken)).toBe(false);
    expect(await authenticates(ownFresh)).toBe(true);
    const bound = await peerRow(own);
    expect(bound).toMatchObject({ by: owner, acts: owner, write: true });
    expect(bound.hash).not.toBe(before);
    // Already bound to the owner and made by it: a later PATCH keeps it.
    r = await call(`/api/peers/${own}`, owner, 'PATCH', { actsAs: 'owner', writeEnabled: true });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.json.inboundToken).toBeUndefined();
    expect(await peerRow(own)).toMatchObject({
      by: owner,
      acts: owner,
      write: true,
      hash: bound.hash,
    });
    expect(await authenticates(ownFresh)).toBe(true);
  });

  it('L-2: a copy’s create that races to a row holding other bytes refuses and leaves it be', async () => {
    const priv = await privateFor(mem);
    const name = 'raced-bytes.txt';
    const disk = f.diskPathForFile('files', name)!;
    const otherRow = randomUUID();
    const data = {
      filename: name,
      extension: 'txt',
      mime_type: 'text/plain',
      size_bytes: 5,
      sha256: sha('OTHER'),
      content: 'OTHER',
    };
    let upsert: Promise<unknown> | undefined;
    let failure: unknown;
    // A row the watcher could have made (no workspace named, no grant a
    // login made, not a copy), but holding other bytes: another create's.
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sql`insert into nodes (id, owner_id, type, title, slug, path, data, tags)
        values (${otherRow}, ${owner}, 'file', ${name}, ${name}, 'files',
                ${JSON.stringify(data)}::jsonb, '{file}')`);
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
    expect(failure).toBeInstanceOf(f.FileNameTakenError);
    // Nothing written to it: its data, its home and its grants as made.
    const [row] = await x<{
      data: Json;
      home: string | null;
      untouched: boolean;
      grants: { ws: string; home: boolean; write: boolean }[];
    }>(sql`
      select n.data, n.home_ws::text as home, n.updated_at = n.created_at as untouched,
             coalesce((select json_agg(json_build_object('ws', g.workspace_id, 'home', g.is_home,
                                                          'write', g.write))
                         from item_grants g where g.node_id = n.id), '[]'::json) as grants
        from nodes n where n.id = ${otherRow}`);
    expect(row!.data).toEqual(data);
    expect(row!.untouched).toBe(true);
    expect(row!.home).not.toBe(priv);
    expect(row!.grants.map((g) => g.ws)).not.toContain(priv);
  });

  it('L-4: another Admin user’s owner-only change racing the owner’s bind lands nowhere', async () => {
    // A member peer another Admin user made; it may arm it while it is not
    // bound to the owner.
    let r = await call('/api/peers', admin2, 'POST', peerBody('race', { actsAs: mem }));
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const peer = (r.json.peer as Json).id as string;
    r = await call(`/api/peers/${peer}`, admin2, 'PATCH', { writeEnabled: false });
    expect(r.status, r.text.slice(0, 200)).toBe(200);

    // Its Write switch while the owner binds the peer: refused, not armed.
    r = await ownerBindsDuring(peer, () =>
      call(`/api/peers/${peer}`, admin2, 'PATCH', { writeEnabled: true }),
    );
    expect(r.status, r.text.slice(0, 200)).toBe(403);
    expect(await peerRow(peer)).toMatchObject({ acts: owner, write: false });

    // Its risky tools, the same.
    await x(sql`update mantle_peers set acts_as_login_id = ${mem}::uuid
                 where id = ${peer}`);
    r = await ownerBindsDuring(peer, () =>
      call(`/api/peers/${peer}`, admin2, 'PATCH', { allowedRiskyTools: [] }),
    );
    expect(r.status, r.text.slice(0, 200)).toBe(403);

    // A new token while the owner binds it: refused, the token unchanged.
    await x(sql`update mantle_peers set acts_as_login_id = ${mem}::uuid
                 where id = ${peer}`);
    r = await call(`/api/peers/${peer}/rotate`, admin2, 'POST'); // a member peer: it may re-key that
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const before = (await peerRow(peer)).hash;
    r = await ownerBindsDuring(peer, () => call(`/api/peers/${peer}/rotate`, admin2, 'POST'));
    expect(r.status, r.text.slice(0, 200)).toBe(403);
    expect((await peerRow(peer)).hash).toBe(before);

    // A peer that is gone is still 404.
    r = await call(`/api/peers/${randomUUID()}`, admin2, 'PATCH', { writeEnabled: true });
    expect(r.status, r.text.slice(0, 200)).toBe(404);
  });
});
