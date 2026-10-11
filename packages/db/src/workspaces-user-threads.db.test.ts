/**
 * Workspaces W7c (migration 0269): each user has their own chat thread with
 * each workspace assistant, and team_messages folds into assistant_messages.
 *
 * A scratch brain is migrated up to 0267, switched onto workspaces, and given
 * the shapes 0269 meets: the owner's history with the Admin assistant from
 * before R3 (no login on the rows, a thread, a digest), a second Admin user's
 * own turn, two members' team threads (one reply marked used_private, one
 * with a trace), a team-portal contact's old thread (no login), and a
 * listener on every channel a chat row can raise. Then 0269 and every later
 * migration run. Checked:
 *
 *  1. Row security: no login reads another login's assistant_messages or
 *     chat_threads rows, a second Admin user against the owner included, nor
 *     another login's digest;
 *  2. the members' rows are in assistant_messages with the same ids, as the
 *     Team assistant's rows of their own login, already digested; the portal
 *     contact's rows are archived only; team_messages is frozen;
 *  3. the owner's history with the Admin assistant is unchanged: the same
 *     rows, in the same order, now named for the owner;
 *  4. the migration raised no summarize_due, conversation_changed,
 *     login_notice or node_ingested, queued no pg-boss job, left the
 *     summarizer's backlog and the extract queue as they were.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-user-threads.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore, ensureTestViewerRoles } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0269_workspaces_user_threads';
const CHANNELS = ['summarize_due', 'conversation_changed', 'login_notice', 'node_ingested'];

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

describe.skipIf(!URL)('per-user threads and the team_messages fold (0269)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: Sql;
  let listener: Sql;
  let m: typeof import('./index');
  const heard: string[] = [];
  const owner = randomUUID();
  const admin2 = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();
  const adminAgent = randomUUID();
  const teamAgent = randomUUID();
  const contact = randomUUID();
  const digest = randomUUID();
  const ids = {
    o1: randomUUID(),
    o2: randomUUID(),
    o3: randomUUID(),
    o4: randomUUID(),
    a2: randomUUID(),
    tA1: randomUUID(),
    tA2: randomUUID(),
    tB1: randomUUID(),
    tB2: randomUUID(),
    portal: randomUUID(),
  };
  const traceId = randomUUID();
  let adminWs = '';
  let teamWs = '';
  let ownerBefore: string[] = [];
  let backlogBefore: Row[] = [];
  let digestUpdatedBefore = '';
  let queueBefore = 0;
  let jobsBefore = -1;
  const since = new Date(Date.now() - 86_400_000);

  const backlog = () => sql<Row[]>`
    select agent_id::text as agent, count(*)::int as n from assistant_messages
     where digest_node_id is null and not (data ? 'superseded_by') and not (data ? 'digest_skip')
     group by agent_id order by 1`;
  const jobs = async () => {
    const [has] = await sql<Row[]>`select to_regclass('pgboss.job') is not null as ok`;
    if (!has!.ok) return -1;
    return Number((await sql<Row[]>`select count(*)::int as n from pgboss.job`)[0]!.n);
  };

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 3, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner, display_name) values
      (${owner}, 'ut-o@example.invalid', 'x', 'admin', true, null),
      (${admin2}, 'ut-a@example.invalid', 'x', 'admin', false, 'Second admin'),
      (${memberA}, 'ut-m@example.invalid', 'x', 'member', false, 'Member A'),
      (${memberB}, 'ut-n@example.invalid', 'x', 'member', false, 'Member B')`;
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    adminWs = (
      await sql<Row[]>`select id::text as id from workspaces where owner_id = ${owner} and is_admin`
    )[0]!.id as string;
    teamWs = (
      await sql<
        Row[]
      >`select id::text as id from workspaces where owner_id = ${owner} and bridge_key = 'team'`
    )[0]!.id as string;
    for (const [ws, login] of [
      [adminWs, admin2],
      [teamWs, memberA],
      [teamWs, memberB],
      [teamWs, admin2],
    ] as const) {
      await sql`insert into workspace_users (workspace_id, login_id, moderator)
        values (${ws}, ${login}, false) on conflict do nothing`;
    }
    await sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role) values
      (${adminAgent}, ${owner}, 'ut-admin', 'Admin assistant', 'test/model', 'x', 'assistant'),
      (${teamAgent}, ${owner}, 'ut-team', 'Team assistant', 'test/model', 'x', 'responder')`;
    await sql`insert into workspace_resources (workspace_id, type, ref_id, write) values
      (${adminWs}, 'assistant', ${adminAgent}, true),
      (${teamWs}, 'assistant', ${teamAgent}, true)`;

    // The owner's history from before R3: no login on the rows.
    const at = (min: number) => new Date(Date.now() - min * 60_000);
    await sql`insert into assistant_messages (id, owner_id, agent_id, direction, text, created_at) values
      (${ids.o1}, ${owner}, ${adminAgent}, 'inbound', 'owner q1', ${at(50)}),
      (${ids.o2}, ${owner}, ${adminAgent}, 'outbound', 'owner a1', ${at(49)}),
      (${ids.o3}, ${owner}, ${adminAgent}, 'inbound', 'owner q2', ${at(48)}),
      (${ids.o4}, ${owner}, ${adminAgent}, 'outbound', 'owner a2', ${at(47)})`;
    // A second Admin user's own turn (R3 stamped its login).
    await sql`insert into assistant_messages (id, owner_id, agent_id, direction, text, login_id, created_at)
      values (${ids.a2}, ${owner}, ${adminAgent}, 'inbound', 'admin2 q', ${admin2}, ${at(45)})`;
    await sql`update assistant_messages set login_id = null where id = any(${[ids.o1, ids.o2, ids.o3, ids.o4]}::uuid[])`;
    await sql`insert into chat_threads (owner_id, agent_id, status, started_at)
      values (${owner}, ${adminAgent}, 'open', ${at(60)})`;
    await sql`update chat_threads set login_id = null where agent_id = ${adminAgent}`;
    // The owner's digest of that history.
    await sql`insert into nodes (id, owner_id, type, title, path, audience, tags, data)
      values (${digest}, ${owner}, 'note', 'Owner digest', 'notes', 'admin',
              ARRAY['conversation-digest']::text[],
              ${sql.json({ kind: 'conversation_digest', agent_id: adminAgent, summary: 'owner topic' })})`;
    await sql`insert into item_grants (node_id, workspace_id, write, is_home)
      values (${digest}, ${adminWs}, false, true) on conflict do nothing`;

    // Two members' team threads, and a portal contact's old one.
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${contact}, ${owner}, 'contact', 'Portal contact', 'contacts', 'admin')`;
    await sql`insert into team_messages (id, owner_id, contact_id, login_id, direction, text, agent_id,
                                         trace_id, used_private, created_at) values
      (${ids.tA1}, ${owner}, null, ${memberA}, 'inbound', 'A asks', null, null, false, ${at(30)}),
      (${ids.tA2}, ${owner}, null, ${memberA}, 'outbound', 'A answer', ${teamAgent}, ${traceId}, true, ${at(29)}),
      (${ids.tB1}, ${owner}, null, ${memberB}, 'inbound', 'B asks', null, null, false, ${at(28)}),
      (${ids.tB2}, ${owner}, null, ${memberB}, 'outbound', 'B answer', ${teamAgent}, null, false, ${at(27)}),
      (${ids.portal}, ${owner}, ${contact}, null, 'inbound', 'portal hello', null, null, false, ${at(26)})`;

    ownerBefore = (
      await sql<Row[]>`select id::text as id from assistant_messages
        where agent_id = ${adminAgent} and login_id is null order by created_at, id`
    ).map((r) => r.id as string);
    backlogBefore = await backlog();
    digestUpdatedBefore = String(
      (await sql<Row[]>`select updated_at::text as u from nodes where id = ${digest}`)[0]!.u,
    );
    jobsBefore = await jobs();

    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    await ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    m = await import('./index');
    const queued = async () =>
      (
        await m.db
          .select({ id: m.nodes.id })
          .from(m.nodes)
          .where(m.unextractedNodeConds(owner, since))
      ).length;
    queueBefore = await queued();
    listener = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    for (const ch of CHANNELS) await listener.listen(ch, (p) => heard.push(`${ch}:${p}`));

    await scratch.migrateRest();
    // Everything committed so far reaches the listener before the checks.
    await sql`select pg_notify('summarize_due', 'barrier')`;
    for (let i = 0; i < 100 && !heard.includes('summarize_due:barrier'); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await queued()).toBe(queueBefore);
  }, 240_000);

  afterAll(async () => {
    await listener?.end();
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  /** The ids `login` reads of a table through its own workspaces' scope. */
  const readsAs = async (login: string, table: 'assistant_messages' | 'chat_threads') =>
    m.withScope(await m.loginScopeFor(login), async () =>
      (
        (await m.db.execute(
          dsql`select id::text as id, login_id::text as login from ${dsql.raw(table)}
                    where owner_id = ${owner} order by created_at, id`,
        )) as unknown as Row[]
      ).map((r) => ({ id: r.id as string, login: r.login as string })),
    );

  it('fires nothing and queues nothing (no LLM work)', async () => {
    expect(heard.filter((h) => h !== 'summarize_due:barrier')).toEqual([]);
    expect(await jobs()).toBe(jobsBefore);
    expect(await backlog()).toEqual(backlogBefore);
  });

  it("keeps the owner's history with the Admin assistant: same rows, same order", async () => {
    const after = (
      await sql<Row[]>`select id::text as id, login_id::text as login from assistant_messages
        where agent_id = ${adminAgent} and login_id = ${owner} order by created_at, id`
    ).map((r) => r.id as string);
    expect(after).toEqual(ownerBefore);
    // Through the owner's own scope: the same rows, and not the second admin's.
    const own = await readsAs(owner, 'assistant_messages');
    expect(own.map((r) => r.id)).toEqual(ownerBefore);
    // The thread and the digest are the owner's now.
    const [t] = await sql<
      Row[]
    >`select login_id::text as l from chat_threads where agent_id = ${adminAgent}`;
    expect(t!.l).toBe(owner);
    const [d] = await sql<Row[]>`select login_id::text as l, data->>'login_id' as dl,
        updated_at::text as u from nodes where id = ${digest}`;
    // Named for the owner; updated_at kept (no drain window reopened).
    expect(d).toEqual({ l: owner, dl: owner, u: digestUpdatedBefore });
    expect(await sql`select 1 from assistant_messages where login_id is null`).toHaveLength(0);
  });

  it('folds each member thread in with the same ids, as their own Team rows', async () => {
    const rows = await sql<Row[]>`
      select id::text as id, agent_id::text as agent, workspace_id::text as ws, login_id::text as login,
             channel, data from assistant_messages
       where id = any(${[ids.tA1, ids.tA2, ids.tB1, ids.tB2, ids.portal]}::uuid[]) order by created_at`;
    expect(rows.map((r) => r.id)).toEqual([ids.tA1, ids.tA2, ids.tB1, ids.tB2]);
    for (const r of rows) {
      expect(r).toMatchObject({ agent: teamAgent, ws: teamWs, channel: 'web' });
      expect((r.data as Row).digest_skip).toBe(true);
    }
    expect(rows.map((r) => r.login)).toEqual([memberA, memberA, memberB, memberB]);
    expect((rows[1]!.data as Row).used_private).toBe(true);
    expect((rows[1]!.data as Row).trace_id).toBe(traceId);
    // The portal contact's row: archived only.
    expect(await sql`select 1 from archive_team_messages where id = ${ids.portal}`).toHaveLength(1);
    // Frozen.
    await expect(
      sql`insert into team_messages (owner_id, login_id, direction, text) values (${owner}, ${memberA}, 'inbound', 'x')`,
    ).rejects.toThrow(/frozen/);
  });

  it('no login reads another login’s messages or threads, a second Admin user included', async () => {
    await sql`insert into chat_threads (owner_id, agent_id, status, login_id)
      values (${owner}, ${adminAgent}, 'open', ${admin2})`;
    await sql`insert into chat_threads (owner_id, agent_id, status, login_id)
      values (${owner}, ${teamAgent}, 'open', ${memberA})`;
    for (const [login, msgs] of [
      [owner, ownerBefore],
      [admin2, [ids.a2]],
      [memberA, [ids.tA1, ids.tA2]],
      [memberB, [ids.tB1, ids.tB2]],
    ] as const) {
      const got = await readsAs(login, 'assistant_messages');
      expect(
        got.map((r) => r.id),
        login,
      ).toEqual([...msgs]);
      const threads = await readsAs(login, 'chat_threads');
      expect(new Set(threads.map((t) => t.login)), login).toEqual(
        new Set(threads.length ? [login] : []),
      );
    }
    // Each has exactly its own open thread.
    expect((await readsAs(admin2, 'chat_threads')).length).toBe(1);
    expect((await readsAs(memberB, 'chat_threads')).length).toBe(0);
    // The owner's digest: the owner reads it, the second Admin user does not.
    const digestAs = async (login: string) =>
      m.withScope(
        await m.loginScopeFor(login),
        async () =>
          (await m.db.execute(dsql`select 1 from nodes where id = ${digest}`)) as unknown as Row[],
      );
    expect(await digestAs(owner)).toHaveLength(1);
    expect(await digestAs(admin2)).toHaveLength(0);
  });

  it('a chat row that names no login is the anchor’s (the stamp), never unreadable', async () => {
    const id = randomUUID();
    await sql`insert into assistant_messages (id, owner_id, agent_id, direction, text)
      values (${id}, ${owner}, ${adminAgent}, 'inbound', 'a heartbeat turn')`;
    const [r] = await sql<
      Row[]
    >`select login_id::text as l from assistant_messages where id = ${id}`;
    expect(r!.l).toBe(owner);
    await sql`delete from assistant_messages where id = ${id}`;
  });

  it('honours mantle.conversation_notify only for the role that owns the tables (W7c fix round 1, L4)', async () => {
    const quiet = await sql.begin(async (tx) => {
      await tx`select set_config('mantle.conversation_notify', 'off', true)`;
      const [own] = await tx<Row[]>`select "public"."mantle_conversation_quiet"() as q`;
      await tx`set local role mantle_view_user`;
      const [viewer] = await tx<Row[]>`select "public"."mantle_conversation_quiet"() as q`;
      return { own: own!.q, viewer: viewer!.q };
    });
    expect(quiet).toEqual({ own: true, viewer: false });
  });

  it('runs a second time without error and changes nothing (W7c fix round 1, L3)', async () => {
    const snapshot = async () => ({
      msgs: await sql<Row[]>`select id::text as id, login_id::text as l, agent_id::text as a,
          workspace_id::text as w from assistant_messages order by id`,
      threads: await sql<Row[]>`select id::text as id, login_id::text as l, status
          from chat_threads order by id`,
      cursors: await sql<Row[]>`select owner_id::text as o, agent_id::text as a, login_id::text as l
          from assistant_read_cursors order by 1, 2, 3`,
      archived: await sql<Row[]>`select id::text as id from archive_team_messages order by id`,
      pk: await sql<Row[]>`select conname from pg_constraint
          where conrelid = 'public.assistant_read_cursors'::regclass and contype = 'p'`,
    });
    const before = await snapshot();
    heard.length = 0;
    const file = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'migrations',
        '0269_workspaces_user_threads.sql',
      ),
      'utf8',
    );
    const statements = file
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean);
    await sql.begin(async (tx) => {
      for (const stmt of statements) await tx.unsafe(stmt);
    });
    expect(await snapshot()).toEqual(before);
    expect(before.pk.map((r) => r.conname)).toEqual([
      'assistant_read_cursors_owner_agent_login_pk',
    ]);
    await sql`select pg_notify('summarize_due', 'barrier2')`;
    for (let i = 0; i < 100 && !heard.includes('summarize_due:barrier2'); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(heard.filter((h) => h !== 'summarize_due:barrier2')).toEqual([]);
  });
});
