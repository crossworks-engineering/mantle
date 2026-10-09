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
    for (const slug of ['access_set', 'note_list']) {
      await q(sqlTag`
        insert into tools (owner_id, slug, name, description, handler, input_schema)
        values (${anchor}, ${slug}, ${slug}, ${`${slug} tool`},
          ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb,
          '{"type":"object","properties":{}}'::jsonb)`);
    }
    const binding = JSON.stringify({
      service: 'mcp-src',
      mcp: { url: 'https://mcp.example.invalid/mcp' },
    });
    await q(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration) values
        (${anchor}, 'mcp-src', ${`${tag} source`}, ARRAY[]::text[], 'admin', true, ${binding}::jsonb),
        (${anchor}, 'g-access', 'g', ARRAY['access_set'], 'admin', true, null)`);
    const [a] = await rows<{ id: string }>(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs) values
        (${anchor}, 'persona', 'p', 'm', 'p', ARRAY['g-access']) returning id`);
    agentId = a!.id;
  }, 60_000);

  afterAll(async () => {
    await q(sqlTag`delete from pending_tool_calls where owner_id = ${anchor}`);
    await q(sqlTag`delete from runs where owner_id = ${anchor}`);
    await q(sqlTag`delete from agents where owner_id = ${anchor}`);
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
    const [after] = await rows<{ state: string; failure: { type?: string } | null }>(sqlTag`
      select state, result->'failure' as failure from run_items where id = ${item!.id}`);
    return after!;
  }

  const groupLevel = async () =>
    (
      await rows<{ audience: string }>(sqlTag`
      select audience from tool_groups where owner_id = ${anchor} and slug = 'mcp-src'`)
    )[0]!.audience;
  const pendingCount = async () =>
    (
      await rows<{ n: number }>(sqlTag`
      select count(*)::int as n from pending_tool_calls
      where owner_id = ${anchor} and tool_slug = 'access_set' and status = 'pending'`)
    )[0]!.n;

  it('lowering a connector through a run waits in Pending, as it would inline', async () => {
    const before = await pendingCount();
    const item = await runOne('access_set', { tool_group_slug: 'mcp-src', level: 'team' }, agentId);
    expect(item.state).toBe('done');
    expect(await groupLevel()).toBe('admin');
    expect(await pendingCount()).toBe(before + 1);
  });

  it('a tool the planning agent does not hold never runs', async () => {
    const item = await runOne('note_list', {}, agentId);
    expect(item.state).toBe('failed');
    expect(item.failure?.type).toBe('tool_not_granted');
  });

  it('a run with no agent fails closed: the opening change still waits', async () => {
    const before = await pendingCount();
    await runOne('access_set', { tool_group_slug: 'mcp-src', level: 'team' });
    expect(await groupLevel()).toBe('admin');
    expect(await pendingCount()).toBe(before + 1);
  });
});
