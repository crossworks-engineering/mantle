/**
 * GET and PUT /api/profile/home-desk on a migrated scratch database, through
 * the full HTTP pipeline (runRoute), in warn and in on (the actor and the
 * edit check together, as on the fleet):
 *
 *  - GET answers the login's own desk and version: null and 0 until a save,
 *    and version 0 for a desk saved before the version (the other member's);
 *  - a desk saved before the version, or with a version that is not a whole
 *    number from 0, takes a save sent with version 0 (200, version 1): the
 *    save checks the version as the read projects it;
 *  - the body names the login (`loginId`): a save naming another login, or
 *    none, is a 401 (code login-mismatch), and nothing is written;
 *  - every login saves its OWN desk compare-and-set: a PUT with the stored
 *    version lands (200, version + 1), one with any other version is a 409
 *    with the stored desk and version, and nothing is written;
 *  - two PUTs sent at once with the same version: exactly one lands, the
 *    other is the 409 naming the winner's desk, and the version goes up once;
 *  - only the caller's own profile row changes: the anchor's row (the brand)
 *    and another member's row are byte-equal before and after, even when the
 *    body also names brain keys;
 *  - the shell never names the desk any more;
 *  - an API key (a member's or the anchor's) is refused 401 at the gate on
 *    both methods, and nothing is written;
 *  - a desk that does not project, or a missing or bad version, is a 400;
 *    a desk the projection would change is a 400, never a 500; a body over
 *    64 KB is a 413; nothing is written in each.
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

describe.skipIf(!DB_URL)(
  '/api/profile/home-desk: every login keeps its own desk, compare-and-set',
  () => {
    type Ts = typeof import('@mantle/db/test-support');
    let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
    let raw: ReturnType<typeof postgres>;
    let m: typeof import('@mantle/db');
    let actorMode: typeof import('../../../../../../packages/db/src/actor');
    let runRoute: typeof import('@/server/run-route').runRoute;
    let dir = '';
    const tag = `hd${randomUUID().slice(0, 6)}`;
    const L = {
      owner: randomUUID(),
      member: randomUUID(),
      other: randomUUID(),
      legacy: randomUUID(),
    };
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

    const call = async (who: string | { key: string }, method: 'GET' | 'PUT', body?: unknown) => {
      const res = await runRoute(who, method, '/api/profile/home-desk', body);
      const text = await res.text();
      expect(text).not.toMatch(/SQLSTATE|permission denied|violates|\n\s+at \S/i);
      return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
    };
    /** A PUT as the client sends it: a login's body names that login
     *  (`loginId`), unless the body names one itself (or `undefined`). */
    const put = (who: string | { key: string }, body: unknown) =>
      call(
        who,
        'PUT',
        typeof who === 'string' && body && typeof body === 'object' && !('loginId' in body)
          ? { ...body, loginId: who }
          : body,
      );
    const get = (who: string | { key: string }) => call(who, 'GET');
    /** The version the member's row holds now, as GET answers it. */
    const versionOf = async (who: string) => (await get(who)).json.version as number;

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
      values (${team}, ${L.member}, false), (${team}, ${L.other}, false),
             (${team}, ${L.legacy}, false)`;
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

    it('GET: null and 0 before a save; a desk saved before the version reads as version 0', async () => {
      await setMode('on');
      const fresh = await get(L.member);
      expect(fresh.status, fresh.text).toBe(200);
      expect(fresh.json).toEqual({ homeDesk: null, version: 0 });
      const other = await get(L.other);
      expect(other.status, other.text).toBe(200);
      expect(other.json).toEqual({ homeDesk: OTHER_DESK, version: 0 });
    });

    let n = 0;
    for (const mode of ['warn', 'on'] as const) {
      it(`${mode}: a member saves its own desk with the stored version, and only its own row changes`, async () => {
        await setMode(mode);
        const anchorBefore = await prefsOf(L.owner);
        const otherBefore = await prefsOf(L.other);
        const version = await versionOf(L.member);
        const mine = desk(++n);
        // Brain keys and another login's id ride along: the route takes the
        // desk alone, for the caller alone.
        const res = await put(L.member, {
          homeDesk: mine,
          version,
          siteName: 'member wrote this',
          timezone: 'Pacific/Auckland',
          userId: L.owner,
        });
        expect(res.status, res.text).toBe(200);
        expect(res.json).toEqual({ homeDesk: mine, version: version + 1 });
        const stored = await prefsOf(L.member);
        expect(stored?.homeDesk).toEqual(mine);
        expect(stored?.homeDeskVersion).toBe(version + 1);
        expect(await prefsOf(L.owner)).toEqual(anchorBefore);
        expect(await prefsOf(L.other)).toEqual(otherBefore);
        expect(anchorBefore).toMatchObject(BRAND);
        expect(otherBefore).toEqual({ homeDesk: OTHER_DESK });
        // GET reads it back for that login; the shell does not carry it.
        expect((await get(L.member)).json).toEqual({ homeDesk: mine, version: version + 1 });
        const shell = await runRoute(L.member, 'GET', '/api/shell');
        expect(shell.status).toBe(200);
        const body = (await shell.json()) as Record<string, unknown>;
        expect(body).not.toHaveProperty('homeDesk');
        expect(body.siteName).toBe(BRAND.siteName);
        expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
      });

      it(`${mode}: a desk saved before the version, or with one that is not a whole number, takes version 0`, async () => {
        await setMode(mode);
        for (const stored of [undefined, '3', -2, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
          const prefs: Prefs =
            stored === undefined
              ? { homeDesk: OTHER_DESK }
              : { homeDesk: OTHER_DESK, homeDeskVersion: stored };
          await raw`insert into profiles (user_id, preferences)
          values (${L.legacy}, ${raw.json(prefs as never)})
          on conflict (user_id) do update set preferences = excluded.preferences`;
          const read = await get(L.legacy);
          expect(read.json, String(stored)).toEqual({ homeDesk: OTHER_DESK, version: 0 });
          const mine = desk(++n);
          const res = await put(L.legacy, { homeDesk: mine, version: 0 });
          expect(res.status, `${String(stored)}: ${res.text}`).toBe(200);
          expect(res.json).toEqual({ homeDesk: mine, version: 1 });
          expect(await prefsOf(L.legacy)).toEqual({ homeDesk: mine, homeDeskVersion: 1 });
        }
        expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
      });

      it(`${mode}: a save naming another login, or none, is a 401, and nothing is written`, async () => {
        await setMode(mode);
        const before = await Promise.all(Object.values(L).map(prefsOf));
        const version = await versionOf(L.member);
        for (const loginId of [L.other, L.owner, undefined, '', 7]) {
          const res = await put(L.member, { homeDesk: desk(777), version, loginId });
          expect(res.status, `${String(loginId)}: ${res.text}`).toBe(401);
          expect(res.json).toEqual({
            error: 'loginId is not the login of this session',
            code: 'login-mismatch',
          });
        }
        expect(await Promise.all(Object.values(L).map(prefsOf))).toEqual(before);
      });

      it(`${mode}: a stale version is a 409 with the stored desk, and nothing is written`, async () => {
        await setMode(mode);
        const before = await prefsOf(L.member);
        const version = await versionOf(L.member);
        expect(version).toBeGreaterThan(0);
        for (const stale of [0, version - 1, version + 1]) {
          const res = await put(L.member, { homeDesk: desk(500), version: stale });
          expect(res.status, `${stale}: ${res.text}`).toBe(409);
          expect(res.json).toEqual({ homeDesk: before?.homeDesk, version });
        }
        expect(await prefsOf(L.member)).toEqual(before);
      });

      it(`${mode}: two saves with the same version at once: exactly one lands`, async () => {
        await setMode(mode);
        const version = await versionOf(L.member);
        const a = desk(++n);
        const b = desk(++n);
        const results = await Promise.all([
          put(L.member, { homeDesk: a, version }),
          put(L.member, { homeDesk: b, version }),
        ]);
        const statuses = results.map((r) => r.status).sort();
        expect(statuses, results.map((r) => r.text).join(' | ')).toEqual([200, 409]);
        const won = results.find((r) => r.status === 200)!;
        const lost = results.find((r) => r.status === 409)!;
        expect(won.json.version).toBe(version + 1);
        // The loser hears the winner's desk, as stored.
        expect(lost.json).toEqual(won.json);
        expect((await get(L.member)).json).toEqual(won.json);
        expect((await prefsOf(L.member))?.homeDeskVersion).toBe(version + 1);
        expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
      });

      it(`${mode}: the anchor saves its own desk; the members' rows stay as they were`, async () => {
        await setMode(mode);
        const memberBefore = await prefsOf(L.member);
        const otherBefore = await prefsOf(L.other);
        const version = await versionOf(L.owner);
        const mine = desk(++n);
        const res = await put(L.owner, { homeDesk: mine, version });
        expect(res.status, res.text).toBe(200);
        const anchor = await prefsOf(L.owner);
        expect(anchor?.homeDesk).toEqual(mine);
        expect(anchor?.homeDeskVersion).toBe(version + 1);
        expect(anchor).toMatchObject(BRAND);
        expect(await prefsOf(L.member)).toEqual(memberBefore);
        expect(await prefsOf(L.other)).toEqual(otherBefore);
        expect(m.takeActorMisses(), 'no actor miss').toEqual([]);
      });

      it(`${mode}: an API key is refused 401 on both methods, and nothing is written`, async () => {
        await setMode(mode);
        const before = await Promise.all(Object.values(L).map(prefsOf));
        for (const who of ['owner', 'member'] as const) {
          const read = await get({ key: keys[who] });
          expect(read.status, `${who} key GET: ${read.text}`).toBe(401);
          const res = await put({ key: keys[who] }, { homeDesk: desk(999), version: 0 });
          expect(res.status, `${who} key PUT: ${res.text}`).toBe(401);
        }
        expect(await Promise.all(Object.values(L).map(prefsOf))).toEqual(before);
      });

      it(`${mode}: a desk that does not project, or a bad version, is a 400, and nothing is written`, async () => {
        await setMode(mode);
        const before = await prefsOf(L.member);
        const version = await versionOf(L.member);
        for (const body of [
          { homeDesk: { v: 2, items: [] }, version },
          { homeDesk: null, version },
          { version },
          {},
          { homeDesk: desk(1) }, // no version
          { homeDesk: desk(1), version: -1 },
          { homeDesk: desk(1), version: 1.5 },
          { homeDesk: desk(1), version: String(version) },
          { homeDesk: desk(1), version: null },
        ]) {
          const res = await put(L.member, body);
          expect(res.status, `${JSON.stringify(body)}: ${res.text}`).toBe(400);
        }
        expect(await prefsOf(L.member)).toEqual(before);
      });

      it(`${mode}: a desk the read would change is a 400, never a 500, and nothing is written`, async () => {
        await setMode(mode);
        const before = await prefsOf(L.member);
        const version = await versionOf(L.member);
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
          const res = await put(L.member, { homeDesk, version });
          expect(res.status, res.text).toBe(400);
        }
        expect(await prefsOf(L.member)).toEqual(before);
      });

      it(`${mode}: a body over 64 KB is a 413, and nothing is written`, async () => {
        await setMode(mode);
        const before = await prefsOf(L.member);
        const res = await runRoute(L.member, 'PUT', '/api/profile/home-desk', {
          homeDesk: desk(1),
          version: await versionOf(L.member),
          pad: 'x'.repeat(65 * 1024),
        });
        expect(res.status, await res.text()).toBe(413);
        expect(await prefsOf(L.member)).toEqual(before);
      });
    }
  },
);
