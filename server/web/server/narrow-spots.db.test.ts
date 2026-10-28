/**
 * The promotion and assistant delete definers (migration 0317,
 * packages/db gateway/spot-definers.ts): on the
 * users and assistants areas' narrow exits the personal space's settle and
 * an assistant's delete are one definer call each, and each answer equals
 * the app's own statements on the full route (the spots promotion-space
 * and agent-conversation they replace). Refused: no or another acting
 * login, a login without the area, a target that is no admin, the write
 * role and the user role.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('0317: the promotion and assistant delete on the narrow route', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let rr: typeof import('@mantle/db/runtime-role');
  let m: typeof import('@mantle/db');
  let v: typeof import('@mantle/db/viewer');
  let content: typeof import('@mantle/content');
  let agents: typeof import('../lib/agents');
  let su: ReturnType<typeof postgres>;
  let nl: ReturnType<typeof postgres>;
  let brain = '';
  const admin = randomUUID();
  /** An Admin workspace member whose areas take users and assistants away. */
  const limited = randomUUID();
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    brain = await ts.ensureTestAnchor(su);
    for (const id of [admin, limited]) {
      await su`insert into auth.users (id, email, password_hash, role)
               values (${id}, ${`${id}@example.test`}, 'x', 'admin')`;
    }
    const ws = await ts.ensureAdminUsers(su, [admin, limited]);
    await su`update workspace_users
                set limits = '{"areas": {"users": "false", "assistants": "false"}}'::jsonb
              where workspace_id = ${ws} and login_id = ${limited}`;
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('@mantle/db/runtime-role');
    m = await import('@mantle/db');
    v = await import('@mantle/db/viewer');
    content = await import('@mantle/content');
    agents = await import('../lib/agents');
    nl = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      { max: 1, prepare: false, onnotice: () => {} },
    );
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    for (const c of [nl, su]) await c?.end();
    await scratch?.drop();
  });

  /** `fn` in an Admin area's request exit of `login`: the narrow route. */
  const exit = <T>(fn: () => Promise<T>, login = admin) =>
    m.runInRequestSlot(async () => {
      m.setRequestActor(m.loginActor(login, 'rw'));
      m.noteRequestSystem('area');
      return fn();
    });
  /** The same exit on the full route (the app's own statements). */
  const exitFull = <T>(fn: () => Promise<T>) => exit(() => m.onFullSystemRoute('profile-row', fn));

  /** A member with a personal space holding a shared item, a submitted one
   *  (each a bundle root) and a private one; then made admin. */
  const promotedMember = async () => {
    const id = randomUUID();
    await su`insert into auth.users (id, email, password_hash, role)
             values (${id}, ${`${id}@example.test`}, 'x', 'member')`;
    const items = [randomUUID(), randomUUID(), randomUUID()];
    await su.begin(async (t) => {
      // Setup rows only: the space's triggers are not what is measured.
      await t`set local session_replication_role = replica`;
      // Every login has its personal space (made with the login, or here).
      await t`insert into spaces (kind, login_id) values ('personal', ${id})
                on conflict do nothing`;
      const [sp] = await t<{ id: string }[]>`
        select id::text as id from spaces where kind = 'personal' and login_id = ${id}`;
      const space = sp!.id;
      for (const [i, n] of items.entries()) {
        await t`insert into nodes (id, owner_id, type, title, path)
                values (${n}, ${space}, 'note', ${`i${i}`}, 'notes')`;
      }
      await t`insert into space_items (node_id, sharing, review_state, submitted_at) values
                (${items[0]!}, 'team', 'draft', null),
                (${items[1]!}, 'private', 'submitted', now()),
                (${items[2]!}, 'private', 'draft', null)`;
      await t`insert into space_item_bundles (root_id, node_id, position) values
                (${items[0]!}, ${items[0]!}, 0), (${items[1]!}, ${items[1]!}, 0)`;
    });
    await su`update auth.users set role = 'admin' where id = ${id}`;
    return { id, items };
  };
  const spaceState = async (items: string[]) =>
    (
      await su<{ s: string }[]>`
      select string_agg(si.sharing || '/' || si.review_state || '/' ||
                        (si.submitted_at is null)::text || '/' ||
                        (select count(*) from space_item_bundles b where b.root_id = si.node_id)::text,
                        ',' order by array_position(${items}::uuid[], si.node_id)) as s
        from space_items si where si.node_id = any(${items}::uuid[])`
    )[0]!.s;

  it("a promotion settles the personal space at the role change's spot, never on the narrow login", async () => {
    const a = await promotedMember();
    const b = await promotedMember();
    const settle = (target: string) =>
      m.db.transaction((tx) => content.settleSpaceOnPromotion(tx, target));
    const sessionOf = async () =>
      ((await m.db.execute(sql`select session_user::text as u`)) as unknown as { u: string }[])[0]!
        .u;
    const atSpot = <T>(fn: () => Promise<T>) =>
      exit(() => m.onFullSystemRoute('login-credential', fn));
    expect(await exit(sessionOf)).toBe(rr.NARROW_ROLE);
    expect(await atSpot(sessionOf)).not.toBe(rr.NARROW_ROLE);
    const before = await spaceState(a.items);
    // The narrow login may not run the definer (dropped from the narrow
    // allowlist): refused whole, nothing settled.
    const err = await exit(() => settle(a.id)).catch((e: unknown) => e);
    expect(m.pgErrorCode(err)).toBe('42501');
    expect(await spaceState(a.items)).toBe(before);
    // The refusal is this cell's own: drained, so the run's denial check
    // (vitest.setup.ts) does not count it.
    const ts = await import('@mantle/db/test-support');
    expect(ts.takeNarrowDenials().length).toBeGreaterThan(0);
    // The product path: the role change's transaction at login-credential.
    const nSpot = await atSpot(() => settle(a.id));
    const nFull = await exitFull(() => settle(b.id));
    expect(nSpot).toBe(2);
    expect(nFull).toBe(2);
    const on = await spaceState(a.items);
    expect(on).toBe('private/draft/true/0,private/draft/true/0,private/draft/true/0');
    expect(await spaceState(b.items)).toBe(on);
    // Again: nothing left to settle, on both.
    expect(await atSpot(() => settle(a.id))).toBe(0);
    expect(await exitFull(() => settle(b.id))).toBe(0);
  });

  it('the promotion definer: the narrow login may not run it; a system session keeps its rule', async () => {
    const member = await promotedMember();
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ran',
        (e: { code?: string }) => e.code,
      );
    // As the narrow login: no EXECUTE, whatever the acting login.
    const narrowCall = (login: string | null) =>
      nl.begin(async (t) => {
        await t`select set_config('mantle.acting_login', ${admin}, true)`;
        return t`select mantle_space_settle_promotion(${login}::uuid, ${member.id}::uuid)`;
      });
    for (const login of [admin, limited, null]) expect(await code(narrowCall(login))).toBe('42501');
    // A system session (the superuser): the definer's own rule, unchanged.
    await su`update auth.users set role = 'member' where id = ${member.id}`;
    const call = (login: string | null, target: string) =>
      su.begin(async (t) => {
        await t`select set_config('mantle.acting_login', ${admin}, true)`;
        return t`select mantle_space_settle_promotion(${login}::uuid, ${target}::uuid)`;
      });
    expect(await code(call(admin, member.id))).toBe('42501');
    await su`update auth.users set role = 'admin' where id = ${member.id}`;
    expect(await code(call(limited, member.id))).toBe('42501');
    expect(await code(call(null, member.id))).toBe('42501');
    expect(await code(call(admin, member.id))).toBe('ran');
    const [g] = await su<{ w: boolean; u: boolean; n: boolean; p: boolean }[]>`
      select has_function_privilege('mantle_write_user', 'public.mantle_space_settle_promotion(uuid,uuid)', 'EXECUTE') as w,
             has_function_privilege(${v.viewerRoleName('user')}, 'public.mantle_space_settle_promotion(uuid,uuid)', 'EXECUTE') as u,
             has_function_privilege('mantle_system_narrow', 'public.mantle_space_settle_promotion(uuid,uuid)', 'EXECUTE') as n,
             has_function_privilege('public', 'public.mantle_space_settle_promotion(uuid,uuid)', 'EXECUTE') as p`;
    expect(g).toEqual({ w: false, u: false, n: false, p: false });
  });

  /** An assistant with two messages, a digest and a chat archive summary. */
  const agentWithConversation = async () => {
    const id = randomUUID();
    const slug = `ag-${id.slice(0, 8)}`;
    await su`insert into agents (id, owner_id, slug, name, model, system_prompt)
             values (${id}, ${brain}, ${slug}, ${slug}, 'test/model', 'You are a test agent.')`;
    await su`insert into assistant_messages (owner_id, agent_id, direction, text) values
               (${brain}, ${id}, 'inbound', 'q'), (${brain}, ${id}, 'outbound', 'a')`;
    await su`insert into nodes (owner_id, type, title, path, tags, data) values
               (${brain}, 'note', 'digest', 'notes', array['conversation-digest'],
                ${JSON.stringify({ agent_id: id })}::jsonb),
               (${brain}, 'note', 'archive', 'notes', '{}',
                ${JSON.stringify({ agent_id: id, kind: 'chat_archive' })}::jsonb)`;
    return id;
  };
  const agentState = async (id: string) =>
    (
      await su<{ a: number; msgs: number; orphaned: number; digests: number }[]>`
      select (select count(*)::int from agents where id = ${id}) as a,
             (select count(*)::int from assistant_messages where agent_id = ${id}) as msgs,
             (select count(*)::int from assistant_messages
               where agent_id is null and text in ('q', 'a') and owner_id = ${brain}) as orphaned,
             (select count(*)::int from nodes where data->>'agent_id' = ${id}::text) as digests`
    )[0]!;

  it('an assistant deleted with and without its conversation through the definer, equal to the full route', async () => {
    for (const conversation of ['delete', 'keep'] as const) {
      await su`delete from assistant_messages where agent_id is null and owner_id = ${brain}`;
      const a = await agentWithConversation();
      const resOn = await exit(() => agents.deleteAgent(brain, a, { conversation }));
      const stateOn = await agentState(a);
      await su`delete from assistant_messages where agent_id is null and owner_id = ${brain}`;
      const b = await agentWithConversation();
      const resFull = await exitFull(() => agents.deleteAgent(brain, b, { conversation }));
      const stateFull = await agentState(b);
      expect({ conversation, ...resOn }).toEqual({ conversation, ...resFull });
      expect({ conversation, ...stateOn }).toEqual({ conversation, ...stateFull });
      expect(stateOn.a).toBe(0);
      if (conversation === 'delete') expect([stateOn.msgs, stateOn.digests]).toEqual([0, 0]);
      else expect(stateOn.orphaned).toBe(2);
    }
    // No such assistant: null on both routes.
    expect(await exit(() => agents.deleteAgent(brain, randomUUID()))).toBeNull();
    expect(await exitFull(() => agents.deleteAgent(brain, randomUUID()))).toBeNull();
  });

  it('the assistant delete definer refuses another or no acting login, a login without the area, another brain', async () => {
    const a = await agentWithConversation();
    const call = (login: string | null, owner = brain) =>
      nl.begin(async (t) => {
        await t`select set_config('mantle.acting_login', ${admin}, true)`;
        return t`select * from mantle_agent_delete(${login}::uuid, ${owner}::uuid, ${a}::uuid, true)`;
      });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ran',
        (e: { code?: string }) => e.code,
      );
    expect(await code(call(limited))).toBe('42501');
    expect(await code(call(null))).toBe('42501');
    expect(await code(call(admin, randomUUID()))).toBe('42501');
    const err = await exit(() => agents.deleteAgent(brain, a), limited).catch((e: unknown) => e);
    expect(m.pgErrorCode(err)).toBe('42501');
    expect((await agentState(a)).a).toBe(1);
    const [g] = await su<{ w: boolean; u: boolean; n: boolean }[]>`
      select has_function_privilege('mantle_write_user', 'public.mantle_agent_delete(uuid,uuid,uuid,boolean)', 'EXECUTE') as w,
             has_function_privilege(${v.viewerRoleName('user')}, 'public.mantle_agent_delete(uuid,uuid,uuid,boolean)', 'EXECUTE') as u,
             has_function_privilege('mantle_system_narrow', 'public.mantle_agent_delete(uuid,uuid,uuid,boolean)', 'EXECUTE') as n`;
    expect(g).toEqual({ w: false, u: false, n: false });
    // Since 0322 the narrow login runs it for no one, its own acting login
    // too; the assistants area's delete runs it at the spot acting-login.
    expect(await code(call(admin))).toBe('42501');
    expect((await agentState(a)).a).toBe(1);
    await exit(() => agents.deleteAgent(brain, a), admin);
    expect((await agentState(a)).a).toBe(0);
  });

  it('round 5: the rights writes run at their spots on the narrow exit, each answer equal to the full route', async () => {
    const pair = await import('../lib/pair-code');
    /** A row less what is minted fresh each call (ids, stamps, hashes, codes, names). */
    const shape = (o: object) =>
      Object.fromEntries(
        Object.entries(o).filter(
          ([k]) => !/(^id$|Id$|At$|hash|code|token|email|displayName|nodeId|title|url)/i.test(k),
        ),
      );
    // A phone pairing code (login-self in the product; the same spot).
    const pOn = await exit(() => pair.issuePairCode(admin));
    const pFull = await exitFull(() => pair.issuePairCode(admin));
    expect(Object.keys(pOn).sort()).toEqual(Object.keys(pFull).sort());
    const [pc] = await su<{ n: number }[]>`
      select count(*)::int as n from pairing_codes where id = any(${[pOn.id, pFull.id]}::uuid[])`;
    expect(pc!.n).toBe(2);
    // A member invite, then its revoke on the narrow login.
    const tag = randomUUID().slice(0, 8);
    const iOn = await exit(() =>
      content.createMemberInvite(brain, { email: `on-${tag}@example.test`, createdBy: admin }),
    );
    const iFull = await exitFull(() =>
      content.createMemberInvite(brain, { email: `full-${tag}@example.test`, createdBy: admin }),
    );
    expect(shape(iOn.invite)).toEqual(shape(iFull.invite));
    expect(await exit(() => content.revokeMemberInvite(brain, iOn.invite.id))).toBe(true);
    expect(await exitFull(() => content.revokeMemberInvite(brain, iFull.invite.id))).toBe(true);
    // A peer: made, bound to the admin with Write on, its item shared, the
    // share revoked (narrow), the binding ended by a session end's unbind.
    const peerFlow = async (run: <T>(fn: () => Promise<T>) => Promise<T>, name: string) => {
      const made = await run(() =>
        content.createPeer(brain, {
          displayName: name,
          baseUrl: `https://${name}.example.test`,
          createdBy: admin,
        }),
      );
      const bound = await run(() =>
        content.setPeerAccess(brain, made.peer.id, {
          actsAs: { loginId: admin },
          writeEnabled: true,
        }),
      );
      const share = await run(() => content.grantPeerShare(brain, made.peer.id, made.peer.nodeId));
      const revoked = await run(() =>
        content.revokePeerShare(brain, made.peer.id, made.peer.nodeId),
      );
      const rotated = await run(() => content.rotateInboundToken(brain, made.peer.id));
      const enabled = await run(() => content.setPeerEnabled(brain, made.peer.id, false));
      return {
        made: shape(made.peer),
        token: typeof made.inboundToken,
        bound: shape(bound!.peer),
        share: share ? shape(share) : null,
        revoked,
        rotated: typeof rotated,
        enabled,
      };
    };
    const on = await peerFlow(exit, `on-${tag}`);
    const full = await peerFlow(exitFull, `full-${tag}`);
    expect(on).toEqual(full);
    expect(on.bound).toMatchObject({ writeEnabled: true });
    expect(on.revoked).toBe(true);
  });

  it('round 6: an assistant and a tool group made, granted, edited, cloned and removed on the narrow exit, each answer equal to the full route', async () => {
    const tg = await import('../lib/tool-groups');
    /** A row less what is fresh each call (ids, stamps, slugs, names). */
    const shape = (o: object) =>
      Object.fromEntries(
        Object.entries(o).filter(
          ([k]) => !/(^id$|Id$|At$|^slug$|^name$|Email$|^toolGroupSlugs$)/.test(k),
        ),
      );
    const flow = async (run: <T>(fn: () => Promise<T>) => Promise<T>, tag: string) => {
      const group = await run(() =>
        tg.createToolGroup(brain, { slug: `g-${tag}`, name: `g ${tag}`, toolSlugs: ['search'] }),
      );
      const groupTools = await run(() =>
        tg.updateToolGroup(brain, group.id, { toolSlugs: ['search', 'calculate'] }),
      );
      const groupEdit = await run(() =>
        tg.updateToolGroup(brain, group.id, { description: 'd', enabled: false }),
      );
      const made = await run(() =>
        agents.createAgent(brain, {
          slug: `a-${tag}`,
          name: `a ${tag}`,
          role: 'responder',
          model: 'm',
          apiKeyId: null,
          systemPrompt: 'p',
          toolGroupSlugs: [],
        }),
      );
      const granted = await run(() =>
        agents.updateAgent(brain, made.id, { toolGroupSlugs: [`g-${tag}`] }),
      );
      const grants = granted!.toolGroupSlugs.map((g) => g.replace(tag, 'TAG'));
      const edited = await run(() =>
        agents.updateAgent(brain, made.id, { description: 'e', thinkingEffort: 'low' }),
      );
      // Round 7: a delegate named (a grant: assistant-grant), then another
      // memory key alone (the narrow login; delegate_to kept).
      const delegated = await run(() =>
        agents.updateAgent(brain, made.id, { memoryConfig: { delegate_to: ['pages'] } }),
      );
      const tuned = await run(() =>
        agents.updateAgent(brain, made.id, { memoryConfig: { max_iterations: 4 } }),
      );
      const [memory] = await su<{ m: unknown }[]>`
        select memory_config as m from agents where id = ${made.id}`;
      const clone = await run(() =>
        agents.cloneAgentForUser(brain, {
          actorId: admin,
          actorEmail: `${admin}@example.test`,
          name: `c ${tag}`,
          sourceAgentId: made.id,
        }),
      );
      const released = await run(() => agents.releaseAssignedAgent(brain, admin));
      const removed = await run(() => tg.deleteToolGroup(brain, group.id));
      const [after] = await su<{ g: string[] }[]>`
        select tool_group_slugs as g from agents where id = ${made.id}`;
      await su`delete from agents where id = any(${[made.id, clone.id]}::uuid[])`;
      return {
        group: shape(group),
        groupTools: shape(groupTools!),
        groupEdit: shape(groupEdit!),
        made: shape(made),
        granted: shape(granted!),
        edited: shape(edited!),
        delegated: shape(delegated!),
        tuned: shape(tuned!),
        memory: memory!.m,
        clone: shape(clone),
        released: released ? shape(released) : null,
        removed,
        grants,
        grantsAfter: after!.g,
      };
    };
    const tag = randomUUID().slice(0, 8);
    const on = await flow(exit, `on-${tag}`);
    const full = await flow(exitFull, `full-${tag}`);
    expect(on).toEqual(full);
    expect(on.grants).toEqual(['g-TAG']);
    expect(on.removed).toBe(true);
    expect(on.grantsAfter).toEqual([]);
    expect(on.memory).toMatchObject({ delegate_to: ['pages'], max_iterations: 4 });
  });
});
