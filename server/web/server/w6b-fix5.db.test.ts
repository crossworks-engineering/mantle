/**
 * Workspaces W6b fix round 5, through the real app (createApp) on a migrated
 * scratch database with signed session cookies:
 *
 *  - M-1: the owner binding a peer to itself re-keys it whenever it moves
 *    into that binding, so a token another Admin user rotated (and saw)
 *    while the peer was bound to a member no longer authenticates;
 *  - L-1: a PATCH from another Admin user that the guard refuses (403)
 *    writes nothing else in its body: `enabled` and the outbound token stay
 *    as they were.
 *  - Fix round 6: an owner PATCH that binds the peer to itself with a blank
 *    outbound token answers 400 before anything is written.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w6b-fix5.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('W6b fix round 5', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // a second Admin user, not the owner
  const mem = randomUUID(); // a member
  const tag = `w6bj${randomUUID().slice(0, 6)}`;

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
  const peerBody = (n: string, extra: Json = {}) => ({
    displayName: `${tag} peer ${n}`,
    baseUrl: 'https://peer.example.invalid',
    ...extra,
  });
  const peerRow = async (id: string) =>
    (
      await x<{
        by: string | null;
        acts: string | null;
        write: boolean;
        hash: string;
        enabled: boolean;
        status: string;
        outbound: string | null;
      }>(sql`
        select created_by::text as by, acts_as_login_id::text as acts, write_enabled as write,
               inbound_token_hash as hash, enabled, status,
               encode(outbound_token_enc, 'hex') as outbound
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
    dir = await mkdtemp(path.join(tmpdir(), 'w6b-fix5-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    // The outbound token is sealed under a 32-byte key; the staged next key
    // takes that role without changing the one the viewer roles derive from.
    process.env.MANTLE_MASTER_KEY_NEXT = randomBytes(32).toString('base64');
    process.env.SESSION_SECRET = 'w6b-fix5-secret-at-least-32-characters!!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
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
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('M-1: a token another Admin user rotated on a member peer dies when the owner binds it', async () => {
    // The owner makes a peer bound to a member: it is the maker.
    let r = await call('/api/peers', owner, 'POST', peerBody('m1', { actsAs: mem }));
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const peer = (r.json.peer as Json).id as string;
    const made = r.json.inboundToken as string;
    expect(await peerRow(peer)).toMatchObject({ by: owner, acts: mem });

    // Another Admin user rotates it (allowed: it acts as a member) and sees
    // the new plaintext.
    r = await call(`/api/peers/${peer}/rotate`, admin2, 'POST');
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const theirs = r.json.inboundToken as string;
    expect(await authenticates(theirs)).toBe(true);
    expect(await authenticates(made)).toBe(false);
    expect((await peerRow(peer)).by).toBe(owner); // still the owner's make

    // The owner binds it to itself: re-keyed, the rotated token is dead.
    r = await call(`/api/peers/${peer}`, owner, 'PATCH', { actsAs: 'owner' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const fresh = r.json.inboundToken as string;
    expect(typeof fresh).toBe('string');
    expect(fresh).not.toBe(theirs);
    expect(await authenticates(theirs)).toBe(false);
    expect(await authenticates(fresh)).toBe(true);
    expect(await peerRow(peer)).toMatchObject({ by: owner, acts: owner });

    // Saved again by the owner while bound to it: the token stays.
    r = await call(`/api/peers/${peer}`, owner, 'PATCH', { actsAs: 'owner' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.json.inboundToken).toBeUndefined();
    expect(await authenticates(fresh)).toBe(true);
  });

  it('L-1: a PATCH the guard refuses leaves enabled and the outbound token as they were', async () => {
    // A member peer another Admin user made, with an outbound token set.
    let r = await call('/api/peers', admin2, 'POST', peerBody('l1', { actsAs: mem }));
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const peer = (r.json.peer as Json).id as string;
    r = await call(`/api/peers/${peer}`, admin2, 'PATCH', { outboundToken: 'first-outbound' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const before = await peerRow(peer);
    expect(before).toMatchObject({ enabled: true, status: 'active' });
    expect(before.outbound).not.toBeNull();

    // Its Write switch, with enabled and a new outbound token in the same
    // body, while the owner binds the peer: refused, and nothing written.
    r = await ownerBindsDuring(peer, () =>
      call(`/api/peers/${peer}`, admin2, 'PATCH', {
        enabled: false,
        outboundToken: 'second-outbound',
        writeEnabled: true,
      }),
    );
    expect(r.status, r.text.slice(0, 200)).toBe(403);
    expect(await peerRow(peer)).toMatchObject({
      acts: owner,
      write: false,
      enabled: true,
      status: 'active',
      outbound: before.outbound,
    });
  });

  it('fix round 6: a blank outbound token is refused (400) before the owner re-key writes', async () => {
    let r = await call('/api/peers', owner, 'POST', peerBody('r6', { actsAs: mem }));
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const peer = (r.json.peer as Json).id as string;
    const made = r.json.inboundToken as string;
    const before = await peerRow(peer);
    expect(before).toMatchObject({ acts: mem });

    r = await call(`/api/peers/${peer}`, owner, 'PATCH', { actsAs: 'owner', outboundToken: '   ' });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
    expect(r.json.inboundToken).toBeUndefined();
    const after = await peerRow(peer);
    expect(after).toMatchObject({ acts: mem, hash: before.hash, outbound: before.outbound });
    expect(await authenticates(made)).toBe(true);
  });
});
