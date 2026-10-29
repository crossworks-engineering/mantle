/**
 * The people routes through the real app (createApp) on a migrated scratch
 * database (plan page d8954876 section 23): the gate, the card, the
 * presence poll and the photo, with real session cookies and real `?at=`
 * asset tokens (the token the shell mints for /api/profile/photo).
 *
 *  - GET /api/people: every card the caller may see, itself included (a
 *    workspace shared, a chat shared), nobody else; an Admin user sees
 *    every usable login. The card's exact fields.
 *  - GET /api/people/:id: the card, or the one 404 (not visible, unknown,
 *    no uuid).
 *  - GET /api/people/presence: only visible ids, online or offline, at
 *    most 200 ids read.
 *  - The description (who a person is to the team): on the card, set by
 *    the login itself (PUT /api/profile/description) or by the users area
 *    (PATCH /api/users/:id), and matched by the directory's search.
 *  - GET /api/people/:id/photo and its alias /api/messenger/photo/:loginId:
 *    a cookie, or the caller's own `?at=` token: a visible login's photo is
 *    served; a login outside the gate is the one 404; an expired token, or
 *    one whose login signed out (its epoch moved), opens nothing (the
 *    gate's 401, as on every asset path); a token never opens another row.
 *
 * The object store (getContent) is a stand-in. No owner session is minted
 * on a real brain: the logins are rows of the scratch database.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/people/people-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const PHOTO_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const h = vi.hoisted(() => ({ keys: [] as string[] }));

vi.mock('@mantle/storage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getContent: vi.fn(async (key: string) => {
    h.keys.push(key);
    return { body: Readable.from([PHOTO_BYTES]), contentLength: PHOTO_BYTES.length };
  }),
}));

describe.skipIf(!URL)('the people routes (the gate, the card, presence, the photo)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;
  let app: import('hono').Hono;
  let tokens: typeof import('@/lib/auth/tokens');
  let dir = '';

  const tag = `ppl${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID(); // the anchor, an Admin user
  const A = randomUUID(); // W
  const B = randomUUID(); // W
  const C = randomUUID(); // W2, in a group with A
  const E = randomUUID(); // W2 only: outside A's gate
  const X = randomUUID(); // disabled, in W
  const W = randomUUID();
  const W2 = randomUUID();
  const hex = (c: string) => c.repeat(64);
  const key = (c: string) => `attachments/${c}${c}/${c}${c}/${hex(c)}`;
  const ver = (c: string) => hex(c).slice(0, 8);

  const cookie = (id: string) => ({
    cookie: `mantle_session=${tokens.buildSessionCookie(id).value}`,
  });
  /** The asset token a login's shell mints (uid the anchor, act the login). */
  const at = (login: string, ttl?: number) =>
    tokens.buildAssetToken(owner, login, 0, ttl ?? tokens.SHORT_ASSET_TOKEN_TTL_SECONDS);
  const get = (p: string, headers: Record<string, string> = {}) =>
    app.request(p, { method: 'GET', headers });
  let ip = 0;
  /** A JSON write with a session cookie (a fresh address per call keeps
   *  the per-IP limits out of the way). */
  const send = (method: 'PUT' | 'PATCH', p: string, login: string, body: unknown) => {
    ip += 1;
    return app.request(p, {
      method,
      headers: {
        ...cookie(login),
        'content-type': 'application/json',
        'x-forwarded-for': `203.0.113.${ip % 250}`,
      },
      body: JSON.stringify(body),
    });
  };
  const json = async (res: Response) => {
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const ids = (list: { id: string }[]) => list.map((p) => p.id).sort();
  const prefs = (login: string, p: Record<string, unknown>) =>
    su(sqlTag`insert into profiles (user_id, preferences) values (${login}, ${JSON.stringify(p)}::jsonb)
      on conflict (user_id) do update set preferences = profiles.preferences || excluded.preferences`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'people-routes-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'people-routes-secret-at-least-32-chars!!';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the people routes test', { status: 503 })),
    );
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);

    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${A}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann'),
      (${B}, ${`${tag}-b@example.invalid`}, 'x', 'member', 'Ben'),
      (${C}, ${`${tag}-c@example.invalid`}, 'x', 'member', 'Cat'),
      (${E}, ${`${tag}-e@example.invalid`}, 'x', 'member', 'Eve'),
      (${X}, ${`${tag}-x@example.invalid`}, 'x', 'member', 'Xan')`);
    await su(sqlTag`update auth.users set disabled_at = now() where id = ${X}`);
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${W}, ${owner}, ${`${tag} W`}), (${W2}, ${owner}, ${`${tag} W2`})`);
    await su(sqlTag`delete from workspace_users where login_id in (${A}, ${B}, ${C}, ${E}, ${X})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values
      (${W}, ${A}), (${W}, ${B}), (${W}, ${X}), (${W2}, ${C}), (${W2}, ${E})`);
    await prefs(owner, { avatarStyle: 'lorelei' });
    await prefs(A, { avatarSeed: 'ann-seed' });
    await prefs(C, {
      description: '  Project manager  ',
      avatarSeed: 'cat-seed',
      avatarPhotoKey: key('c'),
      avatarPhotoType: 'image/png',
    });
    await prefs(E, { avatarPhotoKey: key('e'), avatarPhotoType: 'image/png' });
    // Ben beat a moment ago (online); Cat an hour ago (offline).
    await su(sqlTag`insert into login_presence (login_id, last_active_at) values
      (${B}, now()), (${C}, now() - interval '1 hour')`);
    // The owner (an Admin user, who reaches anyone) puts Ann and Cat in a
    // group: Cat is in Ann's gate through the chat only.
    const ms = await import('@mantle/content/messenger');
    await ms.createMessengerConversation(
      { ownerId: owner, loginId: owner, via: null },
      { kind: 'group', participants: [A, C] },
    );

    tokens = await import('@/lib/auth/tokens');
    const { createApp } = await import('@/server/app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('GET /api/people: every card the caller may see, itself included, and the exact card', async () => {
    const { people } = (await json(await get('/api/people', cookie(A)))) as {
      people: Record<string, unknown>[];
    };
    // Ann: herself, Ben (W), Cat and the owner (the group). Not Eve (W2
    // only), not Xan (disabled).
    expect(ids(people as { id: string }[])).toEqual([A, B, C, owner].sort());
    const cat = people.find((p) => p.id === C)!;
    expect(Object.keys(cat).sort()).toEqual(
      ['avatar', 'description', 'id', 'name', 'photoVersion', 'presence', 'status'].sort(),
    );
    expect(cat).toMatchObject({
      name: 'Cat',
      description: 'Project manager',
      avatar: { style: 'lorelei', seed: 'cat-seed', parts: null },
      photoVersion: ver('c'),
      presence: { state: 'offline' },
      status: null,
    });
    expect(typeof (cat.presence as { lastActiveAt: unknown }).lastActiveAt).toBe('string');
    expect(people.find((p) => p.id === B)).toMatchObject({
      description: null,
      avatar: null,
      photoVersion: null,
      presence: { state: 'online' },
    });
    expect(people.find((p) => p.id === A)).toMatchObject({
      presence: { state: 'offline', lastActiveAt: null },
    });
    // Eve sees Cat (W2) and herself; not Ann, Ben or the owner.
    const eve = (await json(await get('/api/people', cookie(E)))) as { people: { id: string }[] };
    expect(ids(eve.people)).toEqual([C, E].sort());
    // An Admin user sees every usable login (not the disabled one).
    const all = (await json(await get('/api/people', cookie(owner)))) as {
      people: { id: string }[];
    };
    expect(ids(all.people)).toEqual(expect.arrayContaining([A, B, C, E, owner]));
    expect(ids(all.people)).not.toContain(X);
    // No credential: the gate's 401.
    expect((await get('/api/people')).status).toBe(401);
  });

  it('GET /api/people/:id: the card, or the one 404', async () => {
    const one = (await json(await get(`/api/people/${C}`, cookie(A)))) as {
      person: { id: string; name: string };
    };
    expect(one.person).toMatchObject({ id: C, name: 'Cat', photoVersion: ver('c') });
    for (const id of [E, X, randomUUID(), 'not-a-uuid']) {
      const res = await get(`/api/people/${id}`, cookie(A));
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    // Itself.
    expect((await get(`/api/people/${A}`, cookie(A))).status).toBe(200);
  });

  it('GET /api/people/presence: only the ids the caller may see, at most 200 read', async () => {
    const res = await json(
      await get(`/api/people/presence?ids=${B},${C},${E},${X},junk,${randomUUID()}`, cookie(A)),
    );
    const presence = res.presence as { id: string; state: string; lastActiveAt: string | null }[];
    expect(ids(presence)).toEqual([B, C].sort());
    expect(presence.find((p) => p.id === B)).toMatchObject({ state: 'online' });
    expect(presence.find((p) => p.id === C)!.state).toBe('offline');
    for (const p of presence)
      expect(Object.keys(p).sort()).toEqual(['id', 'lastActiveAt', 'state']);
    // Ben past the first 200 ids is not read.
    const filler = Array.from({ length: 200 }, () => randomUUID());
    const late = await json(
      await get(`/api/people/presence?ids=${[...filler, B].join(',')}`, cookie(A)),
    );
    expect(late.presence).toEqual([]);
    expect(await json(await get('/api/people/presence', cookie(A)))).toEqual({ presence: [] });
  });

  it('the photo with a cookie: a visible login is served; anything else is the one 404', async () => {
    const res = await get(`/api/people/${C}/photo?v=${ver('c')}`, cookie(A));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PHOTO_BYTES);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('cache-control')).toContain('private');
    // Another v: revalidated.
    const old = await get(`/api/people/${C}/photo?v=deadbeef`, cookie(A));
    expect(old.status).toBe(200);
    expect(old.headers.get('cache-control')).not.toContain('immutable');
    // Eve is outside Ann's gate; Ben has no photo; an unknown login; no uuid.
    h.keys.length = 0;
    for (const id of [E, B, randomUUID(), 'nope']) {
      expect((await get(`/api/people/${id}/photo`, cookie(A))).status, id).toBe(404);
    }
    expect(h.keys).toEqual([]);
    // The alias answers the same.
    expect((await get(`/api/messenger/photo/${C}`, cookie(A))).status).toBe(200);
    expect((await get(`/api/messenger/photo/${E}`, cookie(A))).status).toBe(404);
  });

  it("the photo with the caller's own ?at= token (desktop app, phone)", async () => {
    // A member's token (Ann) for a login in her gate: served, on both paths.
    for (const p of [`/api/people/${C}/photo`, `/api/messenger/photo/${C}`]) {
      const res = await get(`${p}?v=${ver('c')}&at=${encodeURIComponent(at(A))}`);
      expect(res.status, p).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PHOTO_BYTES);
    }
    // An Admin user's token reaches anyone usable; the anchor's own token
    // (no act) too.
    const adminTok = tokens.buildAssetToken(owner, undefined, 0);
    expect((await get(`/api/people/${E}/photo?at=${encodeURIComponent(adminTok)}`)).status).toBe(
      200,
    );
    // A token for a login outside the caller's gate: the one 404.
    h.keys.length = 0;
    expect((await get(`/api/people/${E}/photo?at=${encodeURIComponent(at(A))}`)).status).toBe(404);
    expect((await get(`/api/messenger/photo/${E}?at=${encodeURIComponent(at(A))}`)).status).toBe(
      404,
    );
    expect(h.keys).toEqual([]);
    // An expired token opens nothing: the gate cannot verify it, so the
    // request carries no credential (the gate's 401, as on every asset
    // path). No byte is read.
    const expired = at(A, -60);
    expect((await get(`/api/people/${C}/photo?at=${encodeURIComponent(expired)}`)).status).toBe(
      401,
    );
    // A token whose login signed out everywhere (its epoch moved): refused.
    await su(sqlTag`update auth.users set session_epoch = session_epoch + 1 where id = ${A}`);
    expect((await get(`/api/people/${C}/photo?at=${encodeURIComponent(at(A))}`)).status).toBe(401);
    await su(sqlTag`update auth.users set session_epoch = 0 where id = ${A}`);
    // A disabled login's token: refused.
    const xTok = at(X);
    expect((await get(`/api/people/${A}/photo?at=${encodeURIComponent(xTok)}`)).status).toBe(401);
    // The token opens the photo rows only: never a card, a list or the
    // presence poll (the gate takes it on the asset paths alone).
    const tok = encodeURIComponent(at(A));
    for (const p of [
      `/api/people?at=${tok}`,
      `/api/people/${C}?at=${tok}`,
      `/api/people/presence?ids=${C}&at=${tok}`,
      `/api/messenger/directory?at=${tok}`,
    ]) {
      expect((await get(p)).status, p).toBe(401);
    }
    // Nor a HEAD of the photo (the gate takes a token on a GET only).
    expect((await app.request(`/api/people/${C}/photo?at=${tok}`, { method: 'HEAD' })).status).toBe(
      401,
    );
    // A token naming another brain (its uid is not this login's anchor).
    const foreign = tokens.buildAssetToken(
      randomUUID(),
      A,
      0,
      tokens.SHORT_ASSET_TOKEN_TTL_SECONDS,
    );
    expect((await get(`/api/people/${C}/photo?at=${encodeURIComponent(foreign)}`)).status).toBe(
      401,
    );
    expect(h.keys).toEqual([]);
  });

  it("the description: the login sets its own, an admin sets anyone's, the team reads it", async () => {
    const card = async (viewer: string, id: string) =>
      (
        (await json(await get(`/api/people/${id}`, cookie(viewer)))) as {
          person: { description: string | null };
        }
      ).person.description;

    // Ben writes his own; Ann (sharing W) reads it on his card.
    const own = await send('PUT', '/api/profile/description', B, { description: ' Developer ' });
    expect(await json(own)).toEqual({ description: 'Developer' });
    expect(await card(A, B)).toBe('Developer');
    expect(
      (
        (await json(await get('/api/profile', cookie(B)))) as {
          preferences: { description?: string };
        }
      ).preferences.description,
    ).toBe('Developer');

    // Over the limit is refused, never cut; the card keeps what it had.
    const long = await send('PUT', '/api/profile/description', B, { description: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    expect(await card(A, B)).toBe('Developer');

    // The directory finds him by it, as an agent asking for "the developer"
    // would; a name search still works.
    const dir = (q: string) =>
      get(`/api/messenger/directory?q=${encodeURIComponent(q)}`, cookie(A))
        .then(json)
        .then((r) => r.entries as { id: string; kind: string; description?: string | null }[]);
    const devs = (await dir('develop')).filter((e) => e.kind === 'login');
    expect(devs.map((e) => e.id)).toEqual([B]);
    expect(devs[0]!.description).toBe('Developer');
    expect((await dir('ben')).filter((e) => e.kind === 'login').map((e) => e.id)).toEqual([B]);

    // A member may not set another login's (the users area is the Admin's).
    expect(
      (await send('PATCH', `/api/users/${A}`, B, { description: 'Not hers to say' })).status,
    ).toBe(403);
    expect(await card(B, A)).toBeNull();

    // The owner (an Admin user) sets Ann's through the users area: the
    // description alone changes no session (her cookie still reads).
    const set = await send('PATCH', `/api/users/${A}`, owner, { description: "Jason's wife" });
    expect(await json(set)).toEqual({ ok: true });
    expect(await card(B, A)).toBe("Jason's wife");
    expect(await card(A, A)).toBe("Jason's wife");
    const users = (await json(await get('/api/users', cookie(owner)))) as {
      users: { id: string; description: string | null }[];
    };
    expect(users.users.find((u) => u.id === A)!.description).toBe("Jason's wife");

    // null clears it.
    expect((await send('PATCH', `/api/users/${A}`, owner, { description: null })).status).toBe(200);
    expect(await card(B, A)).toBeNull();
    expect((await send('PUT', '/api/profile/description', B, { description: null })).status).toBe(
      200,
    );
    expect(await card(A, B)).toBeNull();
  });
});
