/**
 * Who may see whom (packages/content/src/messenger.ts, "Who may see
 * whom"): the one gate of person-to-person reads, on a migrated scratch
 * brain on workspaces. loginVisibleTo answers the whole rule for one login;
 * peopleVisibleTo is the directory part of it.
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
 * and outside one (the module's inline rows), and the two must agree.
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
  });

  it('no uuid, an unknown uuid and an agent id are no login', async () => {
    expect(await sees(A, 'not-a-uuid')).toBe(false);
    expect(await sees(A, randomUUID())).toBe(false);
    expect(await sees(A, agent)).toBe(false);
    expect(await sees(adminB, agent)).toBe(false);
  });
});
