/**
 * Who may see whom (packages/content/src/people.ts, the people gate): the
 * one gate of person-to-person reads, on a migrated scratch brain on
 * workspaces. loginVisibleTo answers the whole rule for one login;
 * peopleVisibleTo is the directory part of it; every other read of the
 * module (personCards, one or all, peoplePresence, personPhoto) answers
 * the same rule, asked beside every case below.
 *
 *  - itself; a login sharing a live workspace; not one in another
 *    workspace; an Admin user sees every usable login;
 *  - a disabled login and an archived workspace's people leave the
 *    directory;
 *  - a person of a chat the caller is in, as it sees the room: a leaver
 *    does not see a later joiner, a late joiner does not see an earlier
 *    leaver;
 *  - an id that is no uuid, an unknown uuid and an agent id are no login.
 *
 * Every answer is asked twice, in the caller's scope (as a request asks it)
 * and outside one, and the two must agree (the module reads by name on the
 * system pool, so a scope changes nothing). The messenger re-exports the
 * gate: the same functions.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/messenger-people.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('who may see whom (loginVisibleTo, peopleVisibleTo)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('./messenger');
  let pp: typeof import('./people');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;

  const tag = `mp${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const adminB = randomUUID();
  const [A, B, C, D, F, G, K] = Array.from({ length: 7 }, () => randomUUID()) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const W = randomUUID();
  const W2 = randomUUID();
  const W3 = randomUUID();
  const agent = randomUUID();

  const actor = (loginId: string) => ({ ownerId: owner, loginId, via: null });
  /** The rule as `caller` asks it, in its own scope (as a request does),
   *  and outside any scope (the inline rows): both must agree. */
  const sees = async (caller: string, target: string) => {
    const scoped = await m.withViewer({ login: caller }, () =>
      ms.loginVisibleTo(actor(caller), target),
    );
    const inline = await ms.loginVisibleTo(actor(caller), target);
    expect(inline, `${caller} -> ${target}: the scoped and the inline rule`).toBe(scoped);
    // Every gated read of the people module answers the same rule.
    const t = target.toLowerCase();
    const one = (await pp.personCards(actor(caller), { only: [target] })).length > 0;
    const all = (await pp.personCards(actor(caller))).some((c) => c.id === t);
    const presence = (await pp.peoplePresence(actor(caller), [target])).length > 0;
    expect([one, all, presence], `${caller} -> ${target}: card, list, presence`).toEqual([
      scoped,
      scoped,
      scoped,
    ]);
    return scoped;
  };
  const directory = async (caller: string) =>
    (await ms.peopleVisibleTo(actor(caller))).map((p) => p.id).sort();

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ms = await import('./messenger');
    pp = await import('./people');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);

    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    const people: [string, string][] = [
      [adminB, 'Bea Admin'],
      [A, 'Ann'],
      [B, 'Ben'],
      [C, 'Cat'],
      [D, 'Dan'],
      [F, 'Fay'],
      [G, 'Gus'],
      [K, 'Kim'],
    ];
    for (const [id, name] of people)
      await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name)
        values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x', ${id === adminB ? 'admin' : 'member'}, ${name})`);
    const [adminWs] = (await su(
      sqlTag`select id::text as id from workspaces where is_admin and archived_at is null limit 1`,
    )) as { id: string }[];
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values (${adminWs!.id}, ${adminB})
      on conflict do nothing`);
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${W}, ${owner}, ${`${tag} W`}), (${W2}, ${owner}, ${`${tag} W2`}), (${W3}, ${owner}, ${`${tag} W3`})`);
    await su(
      sqlTag`delete from workspace_users where login_id in (${A}, ${B}, ${C}, ${D}, ${F}, ${G}, ${K})`,
    );
    // Ann and Ben share W; Ann and Dan share W3 (archived below); Cat, Fay,
    // Gus and Kim are in W2 only.
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values
      (${W}, ${A}), (${W}, ${B}), (${W3}, ${A}), (${W3}, ${D}),
      (${W2}, ${C}), (${W2}, ${F}), (${W2}, ${G}), (${W2}, ${K})`);
    await su(sqlTag`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${agent}, ${owner}, ${`${tag}-tess`}, 'Tess', 'test/model', 'x', 'assistant', ${W})`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('itself and a shared live workspace; not another workspace; an Admin user sees all', async () => {
    expect(await sees(A, A)).toBe(true);
    expect(await sees(A, A.toUpperCase())).toBe(true);
    expect(await sees(A, B)).toBe(true);
    expect(await sees(B, A)).toBe(true);
    expect(await sees(A, C)).toBe(false);
    expect(await sees(C, A)).toBe(false);
    expect(await directory(A)).toEqual([B, D].sort());
    for (const target of [A, B, C, D, F, G, K]) expect(await sees(adminB, target)).toBe(true);
    expect(await directory(adminB)).toEqual(expect.arrayContaining([A, B, C, D, F, G, K]));
  });

  it('a disabled login and the people of an archived workspace leave the directory', async () => {
    expect(await sees(A, D)).toBe(true);
    await su(sqlTag`update workspaces set archived_at = now() where id = ${W3}`);
    expect(await sees(A, D)).toBe(false);
    expect(await directory(A)).toEqual([B]);
    await su(sqlTag`update auth.users set disabled_at = now() where id = ${B}`);
    expect(await sees(A, B)).toBe(false);
    expect(await directory(A)).toEqual([]);
    expect((await ms.peopleVisibleTo(actor(adminB))).some((p) => p.id === B)).toBe(false);
    await su(sqlTag`update auth.users set disabled_at = null where id = ${B}`);
  });

  it('a chat shows its people as the caller sees the room', async () => {
    // A group of the Admin user's holds Ann and Cat: Ann sees Cat, Cat sees Ann.
    const g = await ms.createMessengerConversation(actor(adminB), {
      kind: 'group',
      participants: [A, C],
      title: 'Ops',
    });
    expect(await sees(A, C)).toBe(true);
    expect(await sees(C, A)).toBe(true);
    // A disabled login stays visible in a chat (it is out of the directory).
    await su(sqlTag`update auth.users set disabled_at = now() where id = ${C}`);
    expect(await sees(A, C)).toBe(true);
    await su(sqlTag`update auth.users set disabled_at = null where id = ${C}`);
    // Ann leaves; Fay joins after: Ann still sees Cat, never Fay.
    await ms.leaveMessengerConversation(actor(A), g.conversationId);
    await ms.addMessengerParticipants(actor(adminB), g.conversationId, [F]);
    expect(await sees(A, C)).toBe(true);
    expect(await sees(A, F)).toBe(false);
    // Kim left before Gus joined: Gus never sees Kim, and Kim never Gus.
    const late = await ms.createMessengerConversation(actor(adminB), {
      kind: 'group',
      participants: [K],
      title: 'Late',
    });
    await ms.leaveMessengerConversation(actor(K), late.conversationId);
    await ms.addMessengerParticipants(actor(adminB), late.conversationId, [G]);
    // Gus and Kim share W2: take that away so only the chat could open it.
    await su(sqlTag`delete from workspace_users where workspace_id = ${W2} and login_id = ${K}`);
    expect(await sees(G, K)).toBe(false);
    expect(await sees(K, G)).toBe(false);
    // The room is not empty for them: both see the Admin user who made it
    // (who shares no workspace with either), only through the chat.
    await su(sqlTag`delete from workspace_users where login_id = ${G}`);
    expect(await sees(G, adminB)).toBe(true);
    expect(await sees(K, adminB)).toBe(true);
  });

  it('the messenger re-exports the gate (one copy)', () => {
    expect(ms.loginVisibleTo).toBe(pp.loginVisibleTo);
    expect(ms.peopleVisibleTo).toBe(pp.peopleVisibleTo);
    expect(ms.MESSENGER_ONLINE_MS).toBe(pp.PEOPLE_ONLINE_MS);
  });

  it('the card: its fields, presence online or offline, status null', async () => {
    await su(sqlTag`insert into login_presence (login_id, last_active_at) values
      (${B}, now()), (${adminB}, now() - interval '3 minutes')
      on conflict (login_id) do update set last_active_at = excluded.last_active_at`);
    await su(sqlTag`insert into profiles (user_id, preferences)
      values (${B}, ${JSON.stringify({ avatarSeed: 'ben-seed' })}::jsonb)
      on conflict (user_id) do update set preferences = profiles.preferences || excluded.preferences`);
    const cards = await pp.personCards(actor(adminB));
    const ben = cards.find((c) => c.id === B)!;
    expect(Object.keys(ben).sort()).toEqual(
      ['avatar', 'id', 'name', 'photoVersion', 'presence', 'status'].sort(),
    );
    expect(ben).toMatchObject({
      name: 'Ben',
      avatar: { seed: 'ben-seed', parts: null },
      photoVersion: null,
      presence: { state: 'online' },
      status: null,
    });
    expect(cards.find((c) => c.id === adminB)!.presence.state).toBe('offline');
    expect(cards.find((c) => c.id === C)!.presence).toEqual({
      state: 'offline',
      lastActiveAt: null,
    });
    // The presence poll: the same states, visible ids only (Ann sees Ben
    // through W and Cat through the group she left; not Fay), junk and a
    // repeat dropped.
    const poll = await pp.peoplePresence(actor(A), [B, C, F, 'junk', B.toUpperCase()]);
    expect(poll.map((p) => p.id).sort()).toEqual([B, C].sort());
    expect(poll.find((p) => p.id === B)).toMatchObject({ state: 'online' });
    expect(poll.find((p) => p.id === C)).toEqual({ id: C, state: 'offline', lastActiveAt: null });
    // At most PEOPLE_PRESENCE_MAX ids are read.
    const filler = Array.from({ length: pp.PEOPLE_PRESENCE_MAX }, () => randomUUID());
    expect(await pp.peoplePresence(actor(A), [...filler, B])).toEqual([]);
  });

  it('a photo pointer only through the gate, and only a projected one', async () => {
    const hex = 'f'.repeat(64);
    await su(sqlTag`insert into profiles (user_id, preferences)
      values (${F}, ${JSON.stringify({ avatarPhotoKey: `attachments/ff/ff/${hex}`, avatarPhotoType: 'image/png' })}::jsonb)
      on conflict (user_id) do update set preferences = profiles.preferences || excluded.preferences`);
    // Fay is in W2 (with Cat and Kim), not with Ann.
    expect(await pp.personPhoto(actor(adminB), F)).toEqual({
      key: `attachments/ff/ff/${hex}`,
      type: 'image/png',
      version: hex.slice(0, 8),
    });
    expect(await pp.personPhoto(actor(C), F)).not.toBeNull();
    expect(await pp.personPhoto(actor(A), F)).toBeNull();
    expect(await pp.personPhoto(actor(A), 'nope')).toBeNull();
    // A type outside the raster allowlist is no photo.
    await su(sqlTag`update profiles set preferences = preferences || '{"avatarPhotoType":"image/svg+xml"}'::jsonb
      where user_id = ${F}`);
    expect(await pp.personPhoto(actor(adminB), F)).toBeNull();
  });

  it('no uuid, an unknown uuid and an agent id are no login', async () => {
    expect(await sees(A, 'not-a-uuid')).toBe(false);
    expect(await sees(A, randomUUID())).toBe(false);
    expect(await sees(A, agent)).toBe(false);
    expect(await sees(adminB, agent)).toBe(false);
  });
});
