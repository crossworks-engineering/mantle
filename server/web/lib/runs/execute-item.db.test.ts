/**
 * A queued tool_call item runs on the planning agent's behalf (access matrix
 * T1), on a real, migrated Postgres: lowering a connector through a run
 * waits in Pending like the same call made inline, a tool the agent does not
 * hold never runs, and a run with no agent fails closed (Pending too).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/runs/execute-item.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a run item under the planning agent', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let runs: typeof import('@mantle/runs');
  let exec: typeof import('./execute-item');
  let sqlTag: typeof import('drizzle-orm').sql;
  const anchor = randomUUID();
  const tag = `xi-${randomUUID().slice(0, 8)}`;
  let agentId = '';
  const otherWs = randomUUID();
  const q = (s: ReturnType<typeof sqlTag>) => m.systemDb.execute(s);
  const rows = async <T>(s: ReturnType<typeof sqlTag>) => (await q(s)) as unknown as T[];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    runs = await import('@mantle/runs');
    exec = await import('./execute-item');
    sqlTag = (await import('drizzle-orm')).sql;
    await q(sqlTag`insert into auth.users (id, email, password_hash, role)
      values (${anchor}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await q(sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    for (const slug of ['tool_group_ensure', 'note_list']) {
      await q(sqlTag`
        insert into tools (owner_id, slug, name, description, handler, input_schema)
        values (${anchor}, ${slug}, ${slug}, ${`${slug} tool`},
          ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb,
          '{"type":"object","properties":{}}'::jsonb)`);
    }
    await q(sqlTag`
      insert into tools (owner_id, slug, name, description, handler, input_schema)
      values (${anchor}, 'xi_http', 'xi_http', 'an http tool',
        ${JSON.stringify({ kind: 'http', method: 'GET', url: 'https://example.invalid/x' })}::jsonb,
        '{"type":"object","properties":{}}'::jsonb)`);
    const binding = JSON.stringify({
      service: 'mcp-src',
      mcp: { url: 'https://mcp.example.invalid/mcp' },
    });
    await q(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration) values
        (${anchor}, 'mcp-src', ${`${tag} source`}, ARRAY[]::text[], 'admin', true, ${binding}::jsonb),
        (${anchor}, 'g-access', 'g', ARRAY['tool_group_ensure'], 'admin', true, null),
        (${anchor}, 'g-held', 'g', ARRAY[]::text[], 'admin', true, null)`);
    // A workspace other than Admin, and its assistant, which holds g-held:
    // a change to g-held reaches that workspace's users (W7b), so an agent's
    // change waits for the owner.
    await q(
      sqlTag`insert into workspaces (id, owner_id, name) values (${otherWs}, ${anchor}, ${`${tag} other`})`,
    );
    await q(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs, workspace_id)
      values (${anchor}, 'other-assistant', 'o', 'm', 'p', ARRAY['g-held'], ${otherWs})`);
    const [a] = await rows<{ id: string }>(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs) values
        (${anchor}, 'persona', 'p', 'm', 'p', ARRAY['g-access']) returning id`);
    agentId = a!.id;
  }, 60_000);

  afterAll(async () => {
    await q(sqlTag`delete from pending_tool_calls where owner_id = ${anchor}`);
    await q(sqlTag`delete from runs where owner_id = ${anchor}`);
    await q(sqlTag`delete from agents where owner_id = ${anchor}`);
    await q(sqlTag`delete from workspaces where id = ${otherWs}`);
    await q(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await q(sqlTag`delete from tools where owner_id = ${anchor}`);
    await q(sqlTag`delete from spaces where login_id = ${anchor}`);
    await q(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  }, 60_000);

  /** Plan one tool_call item, make it ready, run it, return its row. */
  async function runOne(tool: string, args: Record<string, unknown>, agent?: string) {
    const { runId } = await runs.createRun(m.db, {
      ownerId: anchor,
      ...(agent ? { agentId: agent } : {}),
      title: `${tag} run`,
      plan: { kind: 'seq', children: [{ kind: 'tool_call', payload: { tool, args } }] } as never,
    });
    const [item] = await rows<{ id: string }>(sqlTag`
      update run_items set state = 'ready'
      where run_id = ${runId} and kind = 'tool_call' returning id`);
    await exec.executeRunItem(item!.id);
    const [after] = await rows<{
      state: string;
      failure: { type?: string } | null;
      untrusted: boolean | null;
    }>(sqlTag`
      select state, result->'failure' as failure, (result->>'untrusted')::boolean as untrusted
        from run_items where id = ${item!.id}`);
    return after!;
  }

  /** g-held's tools: unchanged while the change waits. */
  const heldTools = async () =>
    (
      await rows<{ tools: string[] }>(sqlTag`
      select tool_slugs as tools from tool_groups where owner_id = ${anchor} and slug = 'g-held'`)
    )[0]!.tools;
  // An http tool: the only kind an agent may bundle into a group.
  const ENSURE = { slug: 'g-held', tool_slugs: ['xi_http'] };
  const pendingCount = async () =>
    (
      await rows<{ n: number }>(sqlTag`
      select count(*)::int as n from pending_tool_calls
      where owner_id = ${anchor} and tool_slug = 'tool_group_ensure' and status = 'pending'`)
    )[0]!.n;

  it('changing a group another workspace uses, through a run, waits in Pending, as it would inline', async () => {
    const before = await pendingCount();
    const item = await runOne('tool_group_ensure', ENSURE, agentId);
    expect(item.state, JSON.stringify(item.failure)).toBe('done');
    expect(await heldTools()).toEqual([]);
    expect(await pendingCount()).toBe(before + 1);
  });

  it('a tool the planning agent does not hold never runs', async () => {
    const item = await runOne('note_list', {}, agentId);
    expect(item.state).toBe('failed');
    expect(item.failure?.type).toBe('tool_not_granted');
  });

  it('a run whose agent is gone runs nothing', async () => {
    const item = await runOne('tool_group_ensure', ENSURE, randomUUID());
    expect(item.state).toBe('failed');
    expect(item.failure?.type).toBe('agent_missing');
    expect(await heldTools()).toEqual([]);
  });

  it("a run of another workspace's agent runs nothing: it would read past that workspace", async () => {
    const [low] = await rows<{ id: string }>(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs, workspace_id)
      values (${anchor}, 'team-helper', 't', 'm', 'p', ARRAY['g-access'], ${otherWs}) returning id`);
    const item = await runOne('tool_group_ensure', ENSURE, low!.id);
    expect(item.state).toBe('failed');
    expect(item.failure?.type).toBe('below_admin');
  });

  /** Plan one worker step for `agentId`, make it ready, run it, return it. */
  async function runWorker(agentId: string) {
    const { runId } = await runs.createRun(m.db, {
      ownerId: anchor,
      agentId,
      title: `${tag} worker run`,
      plan: {
        kind: 'seq',
        children: [{ kind: 'worker_invoke', payload: { step: 'read every admin note' } }],
      } as never,
    });
    const [item] = await rows<{ id: string }>(sqlTag`
      update run_items set state = 'ready'
      where run_id = ${runId} and kind = 'worker_invoke' returning id`);
    await exec.executeRunItem(item!.id);
    const [after] = await rows<{ state: string; failure: { type?: string } | null }>(sqlTag`
      select state, result->'failure' as failure from run_items where id = ${item!.id}`);
    return after!;
  }

  it("a worker step of another workspace's agent's run runs nothing (B3)", async () => {
    const [low] = await rows<{ id: string }>(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, workspace_id)
      values (${anchor}, 'team-planner', 't', 'm', 'p', ${otherWs}) returning id`);
    const after = await runWorker(low!.id);
    expect(after.state).toBe('failed');
    expect(after.failure?.type).toBe('below_admin');
  });

  it('a worker step of a run whose agent is gone runs nothing (C2)', async () => {
    const after = await runWorker(randomUUID());
    expect(after.state).toBe('failed');
    expect(after.failure?.type).toBe('agent_missing');
  });

  it("an http row's failure is stored marked: it quotes the remote answer (fix round 1, LOW-6)", async () => {
    await q(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration)
      values (${anchor}, 'g-http', 'g', ARRAY['xi_http'], 'admin', true, null)
      on conflict do nothing`);
    const [a] = await rows<{ id: string }>(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs)
      values (${anchor}, 'http-persona', 'h', 'm', 'p', ARRAY['g-http']) returning id`);
    // example.invalid never answers: the http row fails, in its own words.
    const item = await runOne('xi_http', {}, a!.id);
    expect(item.state).toBe('failed');
    expect(item.failure?.type).toBe('tool_error');
    expect(item.untrusted).toBe(true);
    // A builtin's failure is not third-party text.
    const own = await runOne('note_list', {}, agentId);
    expect(own.state).toBe('failed');
    expect(own.untrusted).toBeNull();
  });

  it('a run with no agent fails closed: the opening change still waits', async () => {
    const before = await pendingCount();
    // An agent that happens to be named 'run' must not become the requester.
    await q(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt)
      values (${anchor}, 'run', 'r', 'm', 'p') on conflict do nothing`);
    await runOne('tool_group_ensure', ENSURE);
    expect(await heldTools()).toEqual([]);
    expect(await pendingCount()).toBe(before + 1);
    // No agent planned it: the Pending row names no requester.
    const [last] = await rows<{ agent_id: string | null }>(sqlTag`
      select agent_id from pending_tool_calls where owner_id = ${anchor}
      order by created_at desc limit 1`);
    expect(last!.agent_id).toBeNull();
  });
});
