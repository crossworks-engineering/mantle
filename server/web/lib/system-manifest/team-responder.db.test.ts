/**
 * The team responder on every brain, a fresh install included. Agent and
 * tool-group levels went in workspaces W7b (frozen by 0268; their route's
 * 410 stub went in arch A7) and left the code in W8c (the seeder writes none, the
 * reconcile reads none). What is left to hold:
 *  - a FRESH install (onboarding's applyManifest) ships the responder with
 *    `team-read`, `team-read-admin` and `formulas-eval`, and only
 *    `team-read-admin` is adminOnly;
 *  - the boot reconcile (reconcileOwner) never puts `team-read-admin` back on
 *    the assistant of the Team workspace (groupsForAgent: by the workspace,
 *    no longer by the level);
 *  - a member's chat with no assistant named goes to the assistant of their
 *    oldest workspace beyond Admin that holds one (defaultWorkspaceAssistant;
 *    the built-in Team's until 0286, a normal workspace's now).
 * The client twin (client-responder, client-read) no longer ships (W5c).
 *
 * Only the two auth checks are stubbed. Seeds its own brains; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/team-responder.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

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
    // The reader a gone stub reads (lib/gone.ts, A4 hand batch A).
    ownerCaller: vi.fn(() => ({ id: h.owner })),
    getMemberOr401: vi.fn(async () => caller('member')),
    getClientOr401: vi.fn(async () => caller('client')),
  };
});

type Row = Record<string, unknown>;

describe.skipIf(!URL)('team-responder opens in one step on every brain', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  /** Fixture writes to the workspace tables, as the superuser: the app pools
   *  only read them. */
  let su: Parameters<typeof m.ensureViewerRoles>[0] | undefined;
  let seed: typeof import('./seed');
  let rec: typeof import('./reconcile');
  let content: typeof import('@mantle/content');
  // fresh: installed with this manifest. opened: an older brain whose admin
  // opened the responder (the old open call took `team-read-admin` off it).
  const brains = { fresh: randomUUID(), opened: randomUUID() };
  // A member login of the fresh brain, the one who chats.
  const member = randomUUID();

  const agent = async (owner: string, slug: string) =>
    (
      await admin<Row[]>`select id, slug, enabled, tool_group_slugs
                          from agents where owner_id = ${owner} and slug = ${slug}`
    )[0]!;
  /** Every group's adminOnly flag on one brain, by slug. */
  const groupsAdminOnly = async (owner: string) =>
    Object.fromEntries(
      (await admin<Row[]>`select slug, admin_only from tool_groups where owner_id = ${owner}`).map(
        (r) => [r.slug as string, r.admin_only as boolean],
      ),
    );
  /** A workspace on the brain holding its team responder (a normal one,
   *  as Team is since 0286), with the member in it. */
  const teamHolds = async (owner: string, agentId: string) => {
    const [ws] = await su!<Row[]>`
      insert into workspaces (owner_id, name) values (${owner}, 'Team') returning id`;
    await su!`insert into workspace_resources (workspace_id, type, ref_id, write)
                values (${ws!.id as string}, 'assistant', ${agentId}, true)`;
    await su!`insert into workspace_users (workspace_id, login_id, moderator)
                values (${ws!.id as string}, ${member}, false)`;
    return ws!.id as string;
  };
  // The member chat's agent with none named (lib/assistant-chat.ts and the
  // turn engine: defaultWorkspaceAssistant).
  const memberChatAgent = async (owner: string) => {
    const a = await content.defaultWorkspaceAssistant(owner, member);
    return a ? { slug: a.slug } : null;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    su = (await import('@mantle/db/test-support')).superuserClient(URL!) as unknown as typeof admin;
    await su`select set_config('mantle.actor', 'system:test', false)`;
    seed = await import('./seed');
    rec = await import('./reconcile');
    content = await import('@mantle/content');
    for (const owner of Object.values(brains)) {
      await asSuperuser()`insert into auth.users (id, email, password_hash, role)
                  values (${owner}, ${`tr-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
      await admin`insert into api_keys (id, user_id, service, label, key_enc)
                  values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`;
    }
    await asSuperuser()`insert into auth.users (id, email, password_hash, role)
                values (${member}, ${`trm-${member.slice(0, 8)}@example.invalid`}, 'x', 'member')`;
    // Each starts as onboarding leaves it, then the older shape is set.
    for (const owner of Object.values(brains)) await seed.applyManifest(owner);
    await admin`update agents set tool_group_slugs = ${['team-read', 'formulas-eval']}
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
    if (su) {
      await su`delete from workspaces where owner_id in ${su(owners)}`.catch(() => undefined);
    }
    await admin`delete from auth.users where id in ${admin(owners)}`;
    await admin`delete from auth.users where id = ${member}`;
    await su?.end();
    await m.closeDb();
  }, 120_000);

  it('a fresh install: the responder’s groups, only team-read-admin adminOnly, no member chat', async () => {
    const adminOnly = await groupsAdminOnly(brains.fresh);
    expect(adminOnly).toMatchObject({
      'team-read': false,
      'formulas-eval': false,
      'team-read-admin': true,
    });
    expect(await agent(brains.fresh, 'team-responder')).toMatchObject({
      enabled: true,
      tool_group_slugs: ['team-read', 'team-read-admin', 'formulas-eval'],
    });
    expect(await memberChatAgent(brains.fresh)).toBeNull();
  }, 120_000);

  it('W8c: the reconcile never puts team-read-admin back on the Team assistant', async () => {
    const row = await agent(brains.opened, 'team-responder');
    await teamHolds(brains.opened, row.id as string);
    await rec.reconcileOwner(brains.opened);
    expect((await agent(brains.opened, 'team-responder')).tool_group_slugs).toEqual([
      'team-read',
      'formulas-eval',
    ]);
  }, 240_000);

  it('the member chat is the assistant of the member’s workspace (W5c, 0286)', async () => {
    const owner = brains.fresh;
    const row = await agent(owner, 'team-responder');
    const wsId = await teamHolds(owner, row.id as string);
    expect(await memberChatAgent(owner)).toMatchObject({ slug: 'team-responder' });
    // A disabled assistant, or an archived workspace, closes it.
    await admin`update agents set enabled = false where id = ${row.id as string}`;
    expect(await memberChatAgent(owner)).toBeNull();
    await admin`update agents set enabled = true where id = ${row.id as string}`;
    await su!`update workspaces set archived_at = now() where id = ${wsId}`;
    expect(await memberChatAgent(owner)).toBeNull();
    await su!`update workspaces set archived_at = null where id = ${wsId}`;
    expect(await memberChatAgent(owner)).toMatchObject({ slug: 'team-responder' });
    // A newer workspace of the member with its own assistant: the oldest
    // workspace's still answers by default; with that one archived, the next.
    const [ws2] = await su!<Row[]>`
      insert into workspaces (owner_id, name, created_at)
      values (${owner}, 'Projects', now() + interval '1 minute') returning id`;
    const [other] = await admin<Row[]>`
      insert into agents (owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${owner}, 'projects-assistant', 'Projects', 'm', 'p', 'responder', ${ws2!.id as string})
      returning id`;
    await su!`insert into workspace_resources (workspace_id, type, ref_id, write)
                values (${ws2!.id as string}, 'assistant', ${other!.id as string}, true)`;
    await su!`insert into workspace_users (workspace_id, login_id, moderator)
                values (${ws2!.id as string}, ${member}, false)`;
    expect(await memberChatAgent(owner)).toMatchObject({ slug: 'team-responder' });
    await su!`update workspaces set archived_at = now() where id = ${wsId}`;
    expect(await memberChatAgent(owner)).toMatchObject({ slug: 'projects-assistant' });
    await su!`update workspaces set archived_at = null where id = ${wsId}`;
    // Not a user of any: none.
    await su!`delete from workspace_users where login_id = ${member}`;
    expect(await memberChatAgent(owner)).toBeNull();
  }, 120_000);

  it('the client twin no longer ships (W5c): no client-responder, no client-read', async () => {
    expect(
      await admin<
        Row[]
      >`select id from agents where owner_id = ${brains.fresh} and slug = 'client-responder'`,
    ).toEqual([]);
    expect((await groupsAdminOnly(brains.fresh))['client-read']).toBeUndefined();
  }, 120_000);
});
