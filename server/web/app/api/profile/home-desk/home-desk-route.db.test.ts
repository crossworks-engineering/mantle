/**
 * PUT /api/profile/home-desk on a migrated scratch database, through the
 * full HTTP pipeline (runRoute), in warn and in on (the actor and the edit
 * check together, as on the fleet):
 *
 *  - every login saves its OWN desk: a member as the anchor (the route is an
 *    any-login row, so a member is no longer refused), and GET /api/shell
 *    reads it back for that login;
 *  - only the caller's own profile row changes: the anchor's row (the brand)
 *    and another member's row are byte-equal before and after, even when the
 *    body also names brain keys (the route takes `homeDesk` alone, and the
 *    write runs in the login's scope, where mantle_profile_writable holds it
 *    to the login's own row);
 *  - an API key (a member's or the anchor's) is refused 401 at the gate, and
 *    nothing is written;
 *  - a desk that does not project is a 400, and nothing is written;
 *  - strict on write: a desk the projection would change (an item dropped,
 *    the list cut, an id or a key with a NUL, a lone surrogate or a space)
 *    is a 400, never a 500 or a partial save, and nothing is written;
 *  - a body over 64 KB is a 413, and nothing is written.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/profile/home-desk/home-desk-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

type Mode = 'warn' | 'on';
type Prefs = Record<string, unknown>;

describe.skipIf(!DB_URL)('PUT /api/profile/home-desk: every login saves its own desk', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let actorMode: typeof import('../../../../../../packages/db/src/actor');
  let runRoute: typeof import('@/server/run-route').runRoute;
  let dir = '';
  const tag = `hd${randomUUID().slice(0, 6)}`;
  const L = { owner: randomUUID(), member: randomUUID(), other: randomUUID() };
  const keys = { owner: '', member: '' };
  /** What the anchor's and the other member's rows hold before any save. */
  const BRAND: Prefs = { siteName: `${tag} brand`, timezone: 'UTC' };
  const OTHER_DESK = { v: 1, items: [], counts: {}, icons: false, clock: 'analog' };

  const desk = (n: number) => ({
    v: 1,
    items: [{ id: 'clock', x: n, y: 0, w: 3, h: 2 }],
    counts: { notes: n },
    icons: true,
    clock: 'digital',
  });

  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
    expect(m.actorCheckMode()).toBe(mode);
  };

  const prefsOf = async (id: string): Promise<Prefs | null> =>
    (await raw<{ p: Prefs }[]>`select preferences as p from profiles where user_id = ${id}`)[0]
      ?.p ?? null;

  const put = async (who: string | { key: string }, body: unknown) => {
    const res = await runRoute(who, 'PUT', '/api/profile/home-desk', body);
    const text = await res.text();
    expect(text).not.toMatch(/SQLSTATE|permission denied|violates|\n\s+at \S/i);
    return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'home-desk-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'home-desk-route-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the home desk test', { status: 503 })),
    );
    m = await import('@mantle/db');
    actorMode = await import('../../../../../../packages/db/src/actor');
    runRoute = (await import('@/server/run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    for (const [who, id] of Object.entries(L)) {
      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'},
                ${who === 'owner' ? 'admin' : 'member'}, ${who})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    const team = (
      await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${L.owner}, ${`${tag} team`}) returning id::text as id`
    )[0]!.id;
    await raw`delete from workspace_users where workspace_id = ${team}`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${team}, ${L.member}, false), (${team}, ${L.other}, false)`;
    // The anchor's row (the brand) and the other member's row (a desk of its
    // own), as they are before any save here.
    await raw`insert into profiles (user_id, preferences) values
      (${L.owner}, ${raw.json(BRAND as never)}),
      (${L.other}, ${raw.json({ homeDesk: OTHER_DESK } as never)})
      on conflict (user_id) do update set preferences = excluded.preferences`;

    const k = await import('@/lib/access-keys');
    for (const who of ['owner', 'member'] as const) {
      const minted = await k.mintAccessKey({
        name: `${tag} ${who} key`,
        loginId: L[who],
        access: 'read_write',
        areas: null,
        riskyTools: [],
        expiresAt: null,
        createdBy: L[who],
        maxLive: 50,
      });
      keys[who] = minted!.key;
    }
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  let n = 0;
  for (const mode of ['warn', 'on'] as const) {
    it(`${mode}: a member saves its own desk, and only its own row changes`, async () => {
      await setMode(mode);
      const anchorBefore = await prefsOf(L.owner);
      const otherBefore = await prefsOf(L.other);
      const mine = desk(++n);
      // Brain keys and another login's id ride along: the route takes the
      // desk alone, for the caller alone.
      const res = await put(L.member, {
        homeDesk: mine,
        siteName: 'member wrote this',
        timezone: 'Pacific/Auckland',
        userId: L.owner,
      });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ homeDesk: mine });
      expect((await prefsOf(L.member))?.homeDesk).toEqual(mine);
      expect(await prefsOf(L.owner)).toEqual(anchorBefore);
      expect(await prefsOf(L.other)).toEqual(otherBefore);
      expect(anchorBefore).toMatchObject(BRAND);
      expect(otherBefore).toEqual({ homeDesk: OTHER_DESK });
      // The shell reads it back for that login, and the brand stays the anchor's.
      const shell = await runRoute(L.member, 'GET', '/api/shell');
      expect(shell.status).toBe(200);
      const body = (await shell.json()) as Record<string, unknown>;
      expect(body.homeDesk).toEqual(mine);
      expect(body.siteName).toBe(BRAND.siteName);
      expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
    });

    it(`${mode}: the anchor saves its own desk; the members' rows stay as they were`, async () => {
      await setMode(mode);
      const memberBefore = await prefsOf(L.member);
      const otherBefore = await prefsOf(L.other);
      const mine = desk(++n);
      const res = await put(L.owner, { homeDesk: mine });
      expect(res.status, res.text).toBe(200);
      const anchor = await prefsOf(L.owner);
      expect(anchor?.homeDesk).toEqual(mine);
      expect(anchor).toMatchObject(BRAND);
      expect(await prefsOf(L.member)).toEqual(memberBefore);
      expect(await prefsOf(L.other)).toEqual(otherBefore);
      expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
    });

    it(`${mode}: an API key is refused 401, and nothing is written`, async () => {
      await setMode(mode);
      const before = await Promise.all(Object.values(L).map(prefsOf));
      for (const who of ['owner', 'member'] as const) {
        const res = await put({ key: keys[who] }, { homeDesk: desk(999) });
        expect(res.status, `${who} key: ${res.text}`).toBe(401);
      }
      expect(await Promise.all(Object.values(L).map(prefsOf))).toEqual(before);
    });

    it(`${mode}: a desk that does not project is a 400, and nothing is written`, async () => {
      await setMode(mode);
      const before = await prefsOf(L.member);
      for (const body of [{ homeDesk: { v: 2, items: [] } }, { homeDesk: null }, {}]) {
        const res = await put(L.member, body);
        expect(res.status, res.text).toBe(400);
      }
      expect(await prefsOf(L.member)).toEqual(before);
    });

    it(`${mode}: a desk the read would change is a 400, never a 500, and nothing is written`, async () => {
      await setMode(mode);
      const before = await prefsOf(L.member);
      const item = (id: string) => ({ id, x: 0, y: 0, w: 1, h: 1 });
      const many = Array.from({ length: 401 }, (_, i) => ({ ...item(`pin:${i}`), y: i }));
      for (const homeDesk of [
        { ...desk(1), items: [item('clock'), null] }, // an item dropped
        { ...desk(1), items: [null, 'x', 7] }, // garbage is not an empty desk
        { ...desk(1), items: many }, // the list cut at the cap
        { ...desk(1), items: [item('a\u0000b')] }, // a NUL
        { ...desk(1), items: [item('\ud800')] }, // a lone surrogate
        { ...desk(1), items: [item('caf\u00e9')] }, // not ASCII
        { ...desk(1), counts: { 'no\u0000tes': 3 } }, // a NUL in a key
        { ...desk(1), counts: { notes: 'many' } }, // a count dropped
      ]) {
        const res = await put(L.member, { homeDesk });
        expect(res.status, res.text).toBe(400);
      }
      expect(await prefsOf(L.member)).toEqual(before);
    });

    it(`${mode}: a body over 64 KB is a 413, and nothing is written`, async () => {
      await setMode(mode);
      const before = await prefsOf(L.member);
      const res = await runRoute(L.member, 'PUT', '/api/profile/home-desk', {
        homeDesk: desk(1),
        pad: 'x'.repeat(65 * 1024),
      });
      expect(res.status, await res.text()).toBe(413);
      expect(await prefsOf(L.member)).toEqual(before);
    });
  }
});
