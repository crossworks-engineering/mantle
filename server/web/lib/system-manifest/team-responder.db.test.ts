/**
 * The team responder opens in ONE step on every brain, a fresh install
 * included.
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
 *    and nothing else, and no other group moved below admin.
 * The client twin (client-responder, client-read) ships open at client level.
 *
 * Only the two auth checks are stubbed. Seeds its own brains; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/team-responder.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANIFEST_TOOL_GROUPS } from './manifest';

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

const toolsOf = (slug: string) => MANIFEST_TOOL_GROUPS.find((g) => g.slug === slug)!.toolSlugs;
const TEAM_TOOLS = [...new Set([...toolsOf('team-read'), ...toolsOf('formulas-eval')])];
const ADMIN_ONLY_TOOLS = toolsOf('team-read-admin');

describe.skipIf(!URL)('team-responder opens in one step on every brain', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let seed: typeof import('./seed');
  let rec: typeof import('./reconcile');
  let content: typeof import('@mantle/content');
  let runtime: typeof import('@mantle/runtime/agent');
  let levelRoute: typeof import('../../app/api/access/agents/[slug]/route');
  let memberChat: typeof import('../../app/api/member/chat/route');
  let clientChat: typeof import('../../app/api/client/chat/route');
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
  const setLevel = (owner: string, slug: string, body: Row) => {
    h.owner = owner;
    return levelRoute.PATCH(
      new Request(`http://brain.test/api/access/agents/${slug}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug }) },
    );
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
    content = await import('@mantle/content');
    runtime = await import('@mantle/runtime/agent');
    levelRoute = await import('../../app/api/access/agents/[slug]/route');
    memberChat = await import('../../app/api/member/chat/route');
    clientChat = await import('../../app/api/client/chat/route');
    for (const owner of Object.values(brains)) {
      await admin`insert into auth.users (id, email, password_hash, role)
                  values (${owner}, ${`tr-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
      await admin`insert into api_keys (id, user_id, service, label, key_enc)
                  values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`;
    }
    // Each starts as onboarding leaves it, then the two older shapes are set.
    for (const owner of Object.values(brains)) await seed.applyManifest(owner);
    await admin`update tool_groups set audience = 'admin'
                where owner_id = ${brains.wrong} and slug in ('team-read', 'formulas-eval')`;
    await admin`update agents set audience = 'team', tool_group_slugs = ${['team-read', 'formulas-eval']}
                where owner_id = ${brains.opened} and slug = 'team-responder'`;
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
    // No widening: these three are the only groups below admin.
    expect(belowAdmin(levels)).toEqual({
      'team-read': 'team',
      'formulas-eval': 'team',
      'client-read': 'client',
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

  it('the refusal names the one group in the way and the fix', async () => {
    const res = await setLevel(brains.fresh, 'team-responder', { audience: 'team' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('group_above_agent');
    expect(body.error).toContain("'team-read-admin' is admin-level");
    expect(body.error).toContain('dropGroupsAbove: true');
    expect(body.error).toContain('drop_groups_above: true');
    // The two member groups are no longer in the way.
    expect(body.error).not.toContain("'team-read' is");
    expect(body.error).not.toContain("'formulas-eval' is");
    // Nothing changed.
    expect((await agent(brains.fresh, 'team-responder')).audience).toBe('admin');
  }, 120_000);

  it('one call opens it: team level, team-read-admin off, the member chat open', async () => {
    const res = await setLevel(brains.fresh, 'team-responder', {
      audience: 'team',
      dropGroupsAbove: true,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: Row }).agent).toMatchObject({
      slug: 'team-responder',
      audience: 'team',
      removedGroups: ['team-read-admin'],
    });
    const row = await agent(brains.fresh, 'team-responder');
    expect(row).toMatchObject({
      audience: 'team',
      tool_group_slugs: ['team-read', 'formulas-eval'],
    });
    expect(await memberChatAgent(brains.fresh)).toMatchObject({ slug: 'team-responder' });
    // No group moved with it.
    expect(belowAdmin(await groupLevels(brains.fresh))).toEqual({
      'team-read': 'team',
      'formulas-eval': 'team',
      'client-read': 'client',
    });
  }, 120_000);

  it('at team level it reaches the member tools and no admin-only tool', async () => {
    const row = await agent(brains.fresh, 'team-responder');
    const tools = await runtime.resolveAgentToolGroups(
      brains.fresh,
      row.tool_group_slugs as string[],
      'team',
    );
    expect([...tools].sort()).toEqual([...TEAM_TOOLS].sort());
    for (const slug of ADMIN_ONLY_TOOLS) expect(tools, slug).not.toContain(slug);
    // Granting the admin group back to it is refused at team level...
    expect(
      await content.agentGrantProblems(brains.fresh, 'team', ['team-read-admin']),
    ).toHaveLength(1);
    // ...and a grant that got there anyway is left out at run time.
    const capped = await runtime.resolveAgentToolGroups(
      brains.fresh,
      ['team-read', 'team-read-admin', 'formulas-eval'],
      'team',
    );
    for (const slug of ADMIN_ONLY_TOOLS) expect(capped, slug).not.toContain(slug);
    // The control: at admin the same grant does reach them.
    const atAdmin = await runtime.resolveAgentToolGroups(
      brains.fresh,
      ['team-read', 'team-read-admin', 'formulas-eval'],
      'admin',
    );
    expect(atAdmin).toEqual(expect.arrayContaining(ADMIN_ONLY_TOOLS));
  }, 120_000);

  it('raising it back to admin closes the chat and keeps its groups as they are', async () => {
    const res = await setLevel(brains.fresh, 'team-responder', { audience: 'admin' });
    expect(res.status).toBe(200);
    expect(await agent(brains.fresh, 'team-responder')).toMatchObject({
      audience: 'admin',
      tool_group_slugs: ['team-read', 'formulas-eval'],
    });
    expect(await memberChatAgent(brains.fresh)).toBeNull();
    // The next reconcile gives an admin-level responder its admin group back.
    await rec.reconcileOwner(brains.fresh);
    expect((await agent(brains.fresh, 'team-responder')).tool_group_slugs).toEqual([
      'team-read',
      'formulas-eval',
      'team-read-admin',
    ]);
  }, 120_000);

  it('a brain installed with the wrong levels: the reconcile sets the two groups, one call opens it', async () => {
    // As found: the plain call is refused for all three groups.
    const before = await setLevel(brains.wrong, 'team-responder', { audience: 'team' });
    expect(before.status).toBe(400);
    const error = ((await before.json()) as { error: string }).error;
    expect(error).toContain("'team-read' is admin-level");
    expect(error).toContain("'formulas-eval' is admin-level");

    const levelsBefore = await groupLevels(brains.wrong);
    await rec.reconcileOwner(brains.wrong);
    const levelsAfter = await groupLevels(brains.wrong);
    // Only the two groups moved; the responder stays closed.
    expect(levelsAfter).toEqual({ ...levelsBefore, 'team-read': 'team', 'formulas-eval': 'team' });
    expect(await agent(brains.wrong, 'team-responder')).toMatchObject({
      audience: 'admin',
      tool_group_slugs: ['team-read', 'team-read-admin', 'formulas-eval'],
    });
    expect(await memberChatAgent(brains.wrong)).toBeNull();

    // The same one step through the owner's tool (MCP / the assistant).
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    const accessSet = BUILTIN_TOOLS.find((t) => t.slug === 'access_set')!;
    const res = await accessSet.handler(
      { agent_slug: 'team-responder', level: 'team', drop_groups_above: true },
      { ownerId: brains.wrong, surface: { kind: 'web' } },
    );
    expect(res).toMatchObject({
      ok: true,
      output: { agent: { audience: 'team', removedGroups: ['team-read-admin'] } },
    });
    expect(await memberChatAgent(brains.wrong)).toMatchObject({ slug: 'team-responder' });
    // A second reconcile changes nothing more.
    await rec.reconcileOwner(brains.wrong);
    expect(await groupLevels(brains.wrong)).toEqual(levelsAfter);
    expect(await agent(brains.wrong, 'team-responder')).toMatchObject({
      audience: 'team',
      tool_group_slugs: ['team-read', 'formulas-eval'],
    });
  }, 240_000);

  it('a brain whose admin already opened it: the reconcile leaves it open and adds no admin group', async () => {
    const levelsBefore = await groupLevels(brains.opened);
    await rec.reconcileOwner(brains.opened);
    expect(await groupLevels(brains.opened)).toEqual(levelsBefore);
    expect(await agent(brains.opened, 'team-responder')).toMatchObject({
      audience: 'team',
      tool_group_slugs: ['team-read', 'formulas-eval'],
    });
    expect(await memberChatAgent(brains.opened)).toMatchObject({ slug: 'team-responder' });
  }, 240_000);

  it('the client twin ships open: client-responder at client, one PATCH is a clean no-op', async () => {
    expect(await agent(brains.fresh, 'client-responder')).toMatchObject({
      audience: 'client',
      enabled: true,
      tool_group_slugs: ['client-read'],
    });
    const res = await setLevel(brains.fresh, 'client-responder', { audience: 'client' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: Row }).agent).toMatchObject({
      audience: 'client',
      removedGroups: [],
    });
    h.owner = brains.fresh;
    const chat = await clientChat.GET(new Request('http://brain.test/api/client/chat'));
    expect(((await chat.json()) as { agent: unknown }).agent).not.toBeNull();
    const tools = await runtime.resolveAgentToolGroups(brains.fresh, ['client-read'], 'client');
    expect([...tools].sort()).toEqual([...toolsOf('client-read')].sort());
  }, 120_000);
});
