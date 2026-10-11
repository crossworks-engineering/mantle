/**
 * The team responder on every brain, a fresh install included. Agent and
 * tool-group levels went in workspaces W7b (frozen by 0268, their route
 * answers 410); what follows is the history the fixtures still model.
 *
 * Migration 0159 set `team-read` and `formulas-eval` to team level by UPDATE,
 * which reached only the brains that existed when it ran: on a brain installed
 * after it the two groups were seeded at admin (the column default), so
 * PATCH /api/access/agents/team-responder { audience: 'team' } answered 400
 * `group_above_agent` until an admin lowered both groups by hand. The manifest
 * now carries their level, so:
 *  - a FRESH install (onboarding's applyManifest) seeds both at team;
 *  - a brain installed with the wrong levels gets them from the boot reconcile
 *    (reconcileOwner), with no migration;
 *  - the responder itself still ships CLOSED (admin); one call opens it, and
 *    that call takes `team-read-admin` off it (`dropGroupsAbove`);
 *  - at team level it reaches the tools of `team-read` and `formulas-eval`
 *    and nothing else, and no other group moved below admin;
 *  - the member chat no longer follows that level (W5c): a member chats with
 *    the assistant the brain's Team workspace holds, whatever its level.
 * The client twin (client-responder, client-read) no longer ships (W5c).
 *
 * Only the two auth checks are stubbed. Seeds its own brains; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/team-responder.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => {
  const caller = (role: 'member' | 'client') => ({
    role,
    loginId: '22222222-2222-4222-8222-222222222222',
    anchorId: h.owner,
    spaceId: '66666666-6666-4666-8666-666666666666',
    email: 'pat@example.invalid',
    displayName: 'Pat',
    contactId: null,
  });
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getOwnerOr401: vi.fn(async () => ({ id: h.owner })),
    getMemberOr401: vi.fn(async () => caller('member')),
    getClientOr401: vi.fn(async () => caller('client')),
  };
});

type Row = Record<string, unknown>;

describe.skipIf(!URL)('team-responder opens in one step on every brain', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let seed: typeof import('./seed');
  let rec: typeof import('./reconcile');
  let levelRoute: typeof import('../../app/api/access/agents/[slug]/route');
  let memberChat: typeof import('../../app/api/member/chat/route');
  // fresh: installed with this manifest. wrong: installed after 0159 and
  // before this fix (both groups at admin; an admin who RAISED them looks the
  // same). opened: an older brain whose admin already opened the responder.
  const brains = { fresh: randomUUID(), wrong: randomUUID(), opened: randomUUID() };

  const agent = async (owner: string, slug: string) =>
    (
      await admin<Row[]>`select id, slug, audience, enabled, tool_group_slugs
                          from agents where owner_id = ${owner} and slug = ${slug}`
    )[0]!;
  /** Every group's level on one brain, by slug. */
  const groupLevels = async (owner: string) =>
    Object.fromEntries(
      (await admin<Row[]>`select slug, audience from tool_groups where owner_id = ${owner}`).map(
        (r) => [r.slug as string, r.audience as string],
      ),
    );
  const belowAdmin = (levels: Record<string, string>) =>
    Object.fromEntries(Object.entries(levels).filter(([, level]) => level !== 'admin'));
  const setLevel = (owner: string) => {
    h.owner = owner;
    return levelRoute.PATCH();
  };
  const memberChatAgent = async (owner: string) => {
    h.owner = owner;
    const res = await memberChat.GET(new Request('http://brain.test/api/member/chat'));
    return ((await res.json()) as { agent: { slug: string } | null }).agent;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    seed = await import('./seed');
    rec = await import('./reconcile');
    levelRoute = await import('../../app/api/access/agents/[slug]/route');
    memberChat = await import('../../app/api/member/chat/route');
    for (const owner of Object.values(brains)) {
      await admin`insert into auth.users (id, email, password_hash, role)
                  values (${owner}, ${`tr-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
      await admin`insert into api_keys (id, user_id, service, label, key_enc)
                  values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`;
    }
    // Each starts as onboarding leaves it, then the two older shapes are set.
    for (const owner of Object.values(brains)) await seed.applyManifest(owner);
    // The levels are frozen since 0268 (W7b): the older shapes are set past
    // the freeze, by a named bypass, as a brain upgraded from them has them.
    await admin.begin(async (tx) => {
      await tx`select mantle_heads_bypass('test fixture')`;
      await tx`update tool_groups set audience = 'admin'
               where owner_id = ${brains.wrong} and slug in ('team-read', 'formulas-eval')`;
      await tx`update agents set audience = 'team', tool_group_slugs = ${['team-read', 'formulas-eval']}
               where owner_id = ${brains.opened} and slug = 'team-responder'`;
    });
  }, 240_000);

  afterAll(async () => {
    if (!admin) return;
    const owners = Object.values(brains);
    for (const t of [
      'prompt_versions',
      'heartbeats',
      'tools',
      'tool_groups',
      'skills',
      'agents',
      'ai_workers',
      'model_pool_entries',
    ]) {
      await admin
        .unsafe(`delete from ${t} where owner_id = any($1::uuid[])`, [owners])
        .catch(() => undefined);
    }
    await admin`delete from api_keys where user_id in ${admin(owners)}`;
    await admin`delete from profiles where id in ${admin(owners)}`.catch(() => undefined);
    await admin`delete from spaces where id in ${admin(owners)}`;
    await admin`delete from auth.users where id in ${admin(owners)}`;
    await m.closeDb();
  }, 120_000);

  it('a fresh install: the two member groups at team, nothing else lowered, the responder closed', async () => {
    const levels = await groupLevels(brains.fresh);
    // No widening: these two are the only groups below admin.
    expect(belowAdmin(levels)).toEqual({
      'team-read': 'team',
      'formulas-eval': 'team',
    });
    expect(levels['team-read-admin']).toBe('admin');
    // The responder is NOT lowered by default: closed until an admin opens it.
    expect(await agent(brains.fresh, 'team-responder')).toMatchObject({
      audience: 'admin',
      enabled: true,
      tool_group_slugs: ['team-read', 'team-read-admin', 'formulas-eval'],
    });
    expect(await memberChatAgent(brains.fresh)).toBeNull();
    h.owner = brains.fresh;
    const post = await memberChat.POST(
      new Request('http://brain.test/api/member/chat', {
        method: 'POST',
        body: JSON.stringify({ text: 'hello' }),
      }),
    );
    expect(post.status).toBe(409);
  }, 120_000);

  it('W7b: the level route answers 410, and the reconcile cannot move a frozen level', async () => {
    const res = await setLevel(brains.wrong);
    expect(res.status).toBe(410);
    // The manifest still names team-read and formulas-eval at team (W8 drops
    // it): the boot reconcile runs without an error and the levels stay.
    const levelsBefore = await groupLevels(brains.wrong);
    expect(levelsBefore['team-read']).toBe('admin');
    await rec.reconcileOwner(brains.wrong);
    expect(await groupLevels(brains.wrong)).toEqual(levelsBefore);
    const levelsOpened = await groupLevels(brains.opened);
    await rec.reconcileOwner(brains.opened);
    expect(await groupLevels(brains.opened)).toEqual(levelsOpened);
    expect(await agent(brains.opened, 'team-responder')).toMatchObject({ audience: 'team' });
  }, 240_000);

  it('the member chat is the Team workspace’s assistant, whatever its level (W5c)', async () => {
    const owner = brains.fresh;
    const row = await agent(owner, 'team-responder');
    // Raised back to admin by the test above: the level does not matter now.
    expect(row.audience).toBe('admin');
    const [ws] = await admin<Row[]>`
      insert into workspaces (owner_id, name, bridge_key) values (${owner}, 'Team', 'team')
      returning id`;
    await admin`insert into workspace_resources (workspace_id, type, ref_id, write)
                values (${ws!.id as string}, 'assistant', ${row.id as string}, true)`;
    expect(await memberChatAgent(owner)).toMatchObject({ slug: 'team-responder' });
    // A disabled assistant, or an archived Team, closes it.
    await admin`update agents set enabled = false where id = ${row.id as string}`;
    expect(await memberChatAgent(owner)).toBeNull();
    await admin`update agents set enabled = true where id = ${row.id as string}`;
    await admin`update workspaces set archived_at = now() where id = ${ws!.id as string}`;
    expect(await memberChatAgent(owner)).toBeNull();
    await admin`update workspaces set archived_at = null where id = ${ws!.id as string}`;
    expect(await memberChatAgent(owner)).toMatchObject({ slug: 'team-responder' });
  }, 120_000);

  it('the client twin no longer ships (W5c): no client-responder, no client-read', async () => {
    expect(
      await admin<
        Row[]
      >`select id from agents where owner_id = ${brains.fresh} and slug = 'client-responder'`,
    ).toEqual([]);
    expect((await groupLevels(brains.fresh))['client-read']).toBeUndefined();
  }, 120_000);
});
