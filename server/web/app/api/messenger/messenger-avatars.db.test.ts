/**
 * The messenger's faces on a real, migrated Postgres (Messenger V1, plan
 * page d8954876): the avatar a login chose in Appearance (or an agent's)
 * and a login's uploaded photo, as the chat window reads them.
 *
 *  - a participant (GET /api/messenger/c/:id and the list) carries
 *    `avatar` in the brain's style and `photoVersion`;
 *  - a directory entry carries `avatar` for a login and for an agent; a
 *    login with no seed is `avatar: null` (initials);
 *  - GET /api/messenger/photo/:loginId serves a photo to a login that
 *    shares a live workspace with its owner, or a chat, or is an Admin
 *    user; the one 404 for anyone else, for a login with no photo and for
 *    an id that is no uuid. `immutable` only for the `v` of the photo
 *    served.
 *
 * The caller (anyLoginCaller) and the object store (getContent) are stand
 * ins; every route runs in the caller's own scope (withViewer), as the
 * gate runs it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run messenger-avatars.db.test
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const PHOTO_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const h = vi.hoisted(() => ({ login: '', owner: '', keys: [] as string[] }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  anyLoginCaller: vi.fn(() => ({ loginId: h.login, brainId: h.owner })),
  // The photo route reads the any-login asset caller (a session or the
  // login's own `?at=` token): the same stand-in.
  anyLoginAssetCaller: vi.fn(() => ({ loginId: h.login, brainId: h.owner })),
}));
vi.mock('@mantle/storage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getContent: vi.fn(async (key: string) => {
    h.keys.push(key);
    return { body: Readable.from([PHOTO_BYTES]), contentLength: PHOTO_BYTES.length };
  }),
}));

type Route = (req: Request, ctx?: { params: Promise<object> }) => Promise<Response>;

describe.skipIf(!URL)('the messenger faces: avatars and the photo route', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('@mantle/content/messenger');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;
  const r: Record<string, Route> = {};

  const tag = `mav${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const D = randomUUID();
  const E = randomUUID();
  const W = randomUUID();
  const W2 = randomUUID();
  const tess = randomUUID();
  const hex = (c: string) => c.repeat(64);
  const key = (c: string) => `attachments/${c}${c}/${c}${c}/${hex(c)}`;
  /** A photo version: the first 8 hex of the content key's sha. */
  const ver = (c: string) => hex(c).slice(0, 8);

  const actor = (loginId: string) => ({ ownerId: owner, loginId, via: null });
  /** Call a route as `loginId`, in its own scope. */
  const as = async (loginId: string, route: string, path: string, params?: object) => {
    h.login = loginId;
    return m.withViewer({ login: loginId }, () =>
      r[route]!(
        new Request(`http://brain.test${path}`),
        params ? { params: Promise.resolve(params) } : undefined,
      ),
    );
  };
  const json = async (res: Response) => {
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  /** A member login in `workspaces`, with a seed and, given a hex char, a
   *  PNG photo. */
  const newLogin = async (name: string, workspaces: string[], photo?: string) => {
    const id = randomUUID();
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name)
      values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x', 'member', ${name})`);
    await su(sqlTag`delete from workspace_users where login_id = ${id}`);
    for (const w of workspaces)
      await su(sqlTag`insert into workspace_users (workspace_id, login_id) values (${w}, ${id})`);
    await prefs(id, {
      avatarSeed: `${name}-seed`,
      ...(photo ? { avatarPhotoKey: key(photo), avatarPhotoType: 'image/png' } : {}),
    });
    return id;
  };
  const photoStatus = async (caller: string, loginId: string) =>
    (await as(caller, 'photo', `/api/messenger/photo/${loginId}`, { loginId })).status;
  const prefs = (login: string, p: Record<string, unknown>) =>
    su(sqlTag`insert into profiles (user_id, preferences) values (${login}, ${JSON.stringify(p)}::jsonb)
      on conflict (user_id) do update set preferences = profiles.preferences || excluded.preferences`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ms = await import('@mantle/content/messenger');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);
    h.owner = owner;

    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${A}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann'),
      (${B}, ${`${tag}-b@example.invalid`}, 'x', 'member', 'Ben'),
      (${C}, ${`${tag}-c@example.invalid`}, 'x', 'member', 'Cat'),
      (${D}, ${`${tag}-d@example.invalid`}, 'x', 'member', 'Dan'),
      (${E}, ${`${tag}-e@example.invalid`}, 'x', 'member', 'Eve')`);
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${W}, ${owner}, ${`${tag} W`}), (${W2}, ${owner}, ${`${tag} W2`})`);
    await su(sqlTag`delete from workspace_users where login_id in (${A}, ${B}, ${C}, ${D}, ${E})`);
    // Ann, Ben and Eve share W; Cat and Dan are in W2 only.
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values
      (${W}, ${A}), (${W}, ${B}), (${W}, ${E}), (${W2}, ${C}), (${W2}, ${D})`);
    await su(sqlTag`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id, avatar)
      values (${tess}, ${owner}, ${`${tag}-tess`}, 'Tess', 'test/model', 'x', 'assistant', ${W},
              ${JSON.stringify({ style: 'legacy', seed: 'tess-seed', parts: { hair: 'long' } })}::jsonb)`);
    await su(sqlTag`insert into workspace_resources (workspace_id, type, ref_id)
      values (${W}, 'assistant', ${tess})`);

    // The brain's style is the anchor's; each login's seed, parts and photo
    // are its own. Eve chose initials (no seed).
    await prefs(owner, { avatarStyle: 'lorelei' });
    await prefs(A, {
      avatarSeed: 'ann-seed',
      avatarParts: { eyes: 'happy' },
      avatarPhotoKey: key('a'),
      avatarPhotoType: 'image/png',
    });
    await prefs(B, { avatarSeed: 'ben-seed' });
    await prefs(C, {
      avatarSeed: 'cat-seed',
      avatarPhotoKey: key('c'),
      avatarPhotoType: 'image/webp',
    });
    await prefs(D, {
      avatarSeed: 'dan-seed',
      avatarPhotoKey: key('d'),
      avatarPhotoType: 'image/jpeg',
    });

    r.conversations = (await import('./conversations/route')).GET as Route;
    r.conversation = (await import('./c/[id]/route')).GET as Route;
    r.directory = (await import('./directory/route')).GET as Route;
    r.photo = (await import('./photo/[loginId]/route')).GET as Route;
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('a participant carries its avatar in the brain style and its photo version', async () => {
    const { conversationId } = await ms.createMessengerConversation(actor(A), {
      kind: 'direct',
      participants: [B],
    });
    const { conversation } = await json(
      await as(B, 'conversation', `/api/messenger/c/${conversationId}`, { id: conversationId }),
    );
    const people = (conversation as { participants: Record<string, unknown>[] }).participants;
    expect(people.find((p) => p.id === A)).toMatchObject({
      kind: 'login',
      name: 'Ann',
      avatar: { style: 'lorelei', seed: 'ann-seed', parts: { eyes: 'happy' } },
      photoVersion: ver('a'),
    });
    expect(people.find((p) => p.id === B)).toMatchObject({
      avatar: { style: 'lorelei', seed: 'ben-seed', parts: null },
      photoVersion: null,
    });
    // The list carries the same people.
    const list = await json(await as(B, 'conversations', '/api/messenger/conversations'));
    const row = (list.rows as Record<string, unknown>[]).find((x) => x.id === conversationId)!;
    expect((row.participants as Record<string, unknown>[]).find((p) => p.id === A)).toMatchObject({
      avatar: { seed: 'ann-seed' },
      photoVersion: ver('a'),
    });
  });

  it('a directory entry carries the avatar of a login and of an agent; no seed is null', async () => {
    const dir = await json(await as(A, 'directory', '/api/messenger/directory'));
    const entries = dir.entries as Record<string, unknown>[];
    expect(entries.find((e) => e.id === B)).toEqual({
      kind: 'login',
      id: B,
      name: 'Ben',
      online: false,
      avatar: { style: 'lorelei', seed: 'ben-seed', parts: null },
      photoVersion: null,
      description: null,
    });
    expect(entries.find((e) => e.id === E)).toMatchObject({ avatar: null, photoVersion: null });
    expect(entries.find((e) => e.id === tess)).toEqual({
      kind: 'agent',
      id: tess,
      name: 'Tess',
      online: false,
      slug: `${tag}-tess`,
      // The stored style is legacy: the brain's style is the one drawn.
      avatar: { style: 'lorelei', seed: 'tess-seed', parts: { hair: 'long' } },
    });
    // Nobody outside Ann's workspaces is listed.
    expect(entries.some((e) => e.id === C || e.id === D)).toBe(false);
  });

  it('the photo route serves a login that shares a workspace, with the profile photo headers', async () => {
    h.keys.length = 0;
    const res = await as(B, 'photo', `/api/messenger/photo/${A}?v=${ver('a')}`, { loginId: A });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PHOTO_BYTES);
    expect(h.keys).toEqual([key('a')]);
    // Another `v` (an old URL) is never cached as this photo.
    const stale = await as(B, 'photo', `/api/messenger/photo/${A}?v=00000000`, { loginId: A });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('the photo route 404s a login that shares no workspace and no chat', async () => {
    h.keys.length = 0;
    const res = await as(A, 'photo', `/api/messenger/photo/${D}?v=${ver('d')}`, { loginId: D });
    expect(res.status).toBe(404);
    // Neither a login with no photo nor an id that is no uuid tells more.
    expect((await as(A, 'photo', `/api/messenger/photo/${B}`, { loginId: B })).status).toBe(404);
    expect(
      (await as(A, 'photo', '/api/messenger/photo/not-a-uuid', { loginId: 'not-a-uuid' })).status,
    ).toBe(404);
    expect(
      (await as(A, 'photo', `/api/messenger/photo/${randomUUID()}`, { loginId: randomUUID() }))
        .status,
    ).toBe(404);
    expect(h.keys).toEqual([]);
  });

  it('a shared chat opens the photo; an Admin user reaches every login', async () => {
    // Cat is in no workspace of Ann's: a 404 until a group holds them both.
    expect((await as(A, 'photo', `/api/messenger/photo/${C}`, { loginId: C })).status).toBe(404);
    await ms.createMessengerConversation(actor(owner), {
      kind: 'group',
      participants: [A, C],
      title: 'Ops',
    });
    const res = await as(A, 'photo', `/api/messenger/photo/${C}`, { loginId: C });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    // Dan shares that group with nobody: still a 404 for Ann.
    expect((await as(A, 'photo', `/api/messenger/photo/${D}`, { loginId: D })).status).toBe(404);
    // The Admin user reaches Dan through the directory rule.
    expect((await as(owner, 'photo', `/api/messenger/photo/${D}`, { loginId: D })).status).toBe(
      200,
    );
  });

  it('a chat opens only the people the caller saw: a leaver, a late joiner, a removed one', async () => {
    const W3 = randomUUID();
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W3}, ${owner}, ${`${tag} W3`})`,
    );
    const [F, G, K, L, M] = (await Promise.all(
      ['Fay', 'Gus', 'Kim', 'Lou', 'Max'].map((n, i) => newLogin(n, [W3], String(i + 1))),
    )) as [string, string, string, string, string];
    // Ann leaves a group Fay is in; Gus is added after: Fay yes, Gus no.
    const left = await ms.createMessengerConversation(actor(owner), {
      kind: 'group',
      participants: [A, F],
      title: 'Left',
    });
    await ms.leaveMessengerConversation(actor(A), left.conversationId);
    await ms.addMessengerParticipants(actor(owner), left.conversationId, [G]);
    expect(await photoStatus(A, F)).toBe(200);
    expect(await photoStatus(A, G)).toBe(404);
    // Kim left before Ann joined: Ann never sees Kim.
    const late = await ms.createMessengerConversation(actor(owner), {
      kind: 'group',
      participants: [K],
      title: 'Late',
    });
    await ms.leaveMessengerConversation(actor(K), late.conversationId);
    await ms.addMessengerParticipants(actor(owner), late.conversationId, [A]);
    expect(await photoStatus(A, K)).toBe(404);
    // Ann is removed from a group Lou is in; Max is added after.
    const removed = await ms.createMessengerConversation(actor(owner), {
      kind: 'group',
      participants: [A, L],
      title: 'Removed',
    });
    await ms.removeMessengerParticipant(actor(owner), removed.conversationId, A);
    await ms.addMessengerParticipants(actor(owner), removed.conversationId, [M]);
    expect(await photoStatus(A, L)).toBe(200);
    expect(await photoStatus(A, M)).toBe(404);
  });

  it('a disabled login and an archived workspace open nothing; self and any uuid case do', async () => {
    const H = await newLogin('Hal', [W], '6');
    await su(sqlTag`update auth.users set disabled_at = now() where id = ${H}`);
    expect(await photoStatus(A, H)).toBe(404);
    const W4 = randomUUID();
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W4}, ${owner}, ${`${tag} W4`})`,
    );
    const I = await newLogin('Ivy', [W4], '7');
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values (${W4}, ${A})`);
    expect(await photoStatus(A, I)).toBe(200);
    await su(sqlTag`update workspaces set archived_at = now() where id = ${W4}`);
    expect(await photoStatus(A, I)).toBe(404);
    // Its own photo, and an id in capitals names the same login.
    expect(await photoStatus(A, A)).toBe(200);
    expect(await photoStatus(B, A.toUpperCase())).toBe(200);
    // An agent id is no login.
    expect(await photoStatus(A, tess)).toBe(404);
  });

  it('every 404 is the same answer, and a photo of an unlisted type is none', async () => {
    const N = await newLogin('Ned', [W]);
    await prefs(N, { avatarPhotoKey: key('8'), avatarPhotoType: 'image/svg+xml' });
    const dir = await json(await as(A, 'directory', '/api/messenger/directory'));
    expect((dir.entries as Record<string, unknown>[]).find((e) => e.id === N)).toMatchObject({
      avatar: { seed: 'Ned-seed' },
      photoVersion: null,
    });
    const answer = async (loginId: string) => {
      const res = await as(A, 'photo', `/api/messenger/photo/${loginId}`, { loginId });
      return { status: res.status, headers: [...res.headers], body: await res.text() };
    };
    const noPhoto = await answer(B);
    expect(noPhoto.status).toBe(404);
    expect(await answer(N)).toEqual(noPhoto);
    expect(await answer(D)).toEqual(noPhoto);
    expect(await answer(randomUUID())).toEqual(noPhoto);
    expect(await answer('not-a-uuid')).toEqual(noPhoto);
  });

  it("an agent's avatar falls back to its slug, and no avatar is null", async () => {
    const W5 = randomUUID();
    const W6 = randomUUID();
    const ida = randomUUID();
    const jon = randomUUID();
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${W5}, ${owner}, ${`${tag} W5`}), (${W6}, ${owner}, ${`${tag} W6`})`);
    await su(
      sqlTag`insert into workspace_users (workspace_id, login_id) values (${W5}, ${A}), (${W6}, ${A})`,
    );
    await su(sqlTag`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id, avatar)
      values (${ida}, ${owner}, ${`${tag}-ida`}, 'Ida', 'test/model', 'x', 'assistant', ${W5},
              ${JSON.stringify({ style: 'legacy', seed: '' })}::jsonb),
             (${jon}, ${owner}, ${`${tag}-jon`}, 'Jon', 'test/model', 'x', 'assistant', ${W6}, null)`);
    await su(sqlTag`insert into workspace_resources (workspace_id, type, ref_id)
      values (${W5}, 'assistant', ${ida}), (${W6}, 'assistant', ${jon})`);
    const dir = await json(await as(A, 'directory', '/api/messenger/directory'));
    const entries = dir.entries as Record<string, unknown>[];
    expect(entries.find((e) => e.id === ida)).toMatchObject({
      avatar: { style: 'lorelei', seed: `${tag}-ida`, parts: null },
    });
    expect(entries.find((e) => e.id === jon)).toMatchObject({ kind: 'agent', avatar: null });
    expect(entries.find((e) => e.id === jon)).not.toHaveProperty('photoVersion');
  });
});
