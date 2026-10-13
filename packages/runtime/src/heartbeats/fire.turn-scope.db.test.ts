/**
 * A heartbeat fire and an invoke_agent of the Team assistant run inside its
 * workspace (workspaces W4b fix round 1, M2): tools resolved and the loop
 * run in a turn scope of Team (read only: neither answers a login), so an
 * adminOnly group drops out and reads see only what Team holds. The Admin
 * assistant cannot be invoked from inside a Team turn. System work with no
 * login that delegates to a responder on no workspace is refused (W8 final).
 * Only the model, the
 * embedder and the API key are faked; the rest is the real fire and the real
 * delegation on a scratch brain the workspaces migration made live.
 *
 * On a scratch database of its own: the workspaces migration is per brain.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/heartbeats/fire.turn-scope.db.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  vec: [] as number[],
  q: '',
  adminPage: '',
  calls: 0,
  offered: [] as string[],
  seenToolResults: [] as string[],
}));

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => h.vec),
  embedMany: vi.fn(async (_o: string, texts: string[]) => texts.map(() => h.vec)),
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-fake'),
}));
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // A scripted model: a team read, a read aimed at an admin page, and the
  // adminOnly replay tool; then it answers.
  const chat = async (opts: {
    messages: Array<{ role: string; content?: unknown }>;
    tools?: unknown;
  }) => {
    h.calls += 1;
    // The tool NAMES offered (descriptions may mention other tools).
    for (const t of (opts.tools ?? []) as Array<{ name?: string; function?: { name?: string } }>) {
      h.offered.push(t.function?.name ?? t.name ?? '');
    }
    for (const m of opts.messages) {
      if (m.role === 'tool') h.seenToolResults.push(JSON.stringify(m.content));
    }
    if (h.calls === 1) {
      const call = (id: string, name: string, args: Record<string, unknown>) => ({
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
      return {
        text: '',
        model: 'fake/model',
        toolCalls: [
          call('t1', 'search_nodes', { q: h.q }),
          call('t2', 'node_read', { node_id: h.adminPage }),
          call('t3', 'replay_window', { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }),
        ],
      };
    }
    return { text: 'ok, done', model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('the Team assistant outside a chat turn runs in Team (M2)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  const ownerId = crypto.randomUUID();
  const memberLoginId = crypto.randomUUID();
  const tag = `wsfire-${ownerId.slice(0, 8)}`;
  const apiKeyId = crypto.randomUUID();
  let agentId = '';
  let team = '';
  const ids = { teamPage: crypto.randomUUID(), adminPage: crypto.randomUUID() };
  const x = async <T>(q: ReturnType<typeof import('drizzle-orm').sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const ITEM_ID_RE =
    /\\*"(?:id|nodeId)\\*"\s*:\s*\\*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    await x(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${ownerId}, ${`o-${tag}@example.invalid`}, 'x', 'admin', true),
      (${memberLoginId}, ${`m-${tag}@example.invalid`}, 'x', 'member', false)`);
    h.vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    h.q = tag;
    h.adminPage = ids.adminPage;
    const vec = `[${h.vec.join(',')}]`;
    await x(sqlTag`insert into nodes (id, owner_id, type, title, path, audience, embedding) values
      (${ids.teamPage}, ${ownerId}, 'page', ${`${tag} team page`}, 'pages', 'team', ${vec}::vector),
      (${ids.adminPage}, ${ownerId}, 'page', ${`${tag} admin page`}, 'pages', 'admin', ${vec}::vector)`);
    for (const slug of ['search_nodes', 'node_read', 'replay_window']) {
      const def = BUILTIN_TOOLS.find((t) => t.slug === slug)!;
      await x(sqlTag`insert into tools (owner_id, slug, name, description, input_schema, handler)
        values (${ownerId}, ${slug}, ${def.name}, ${def.description},
                ${JSON.stringify(def.inputSchema)}::jsonb,
                ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb)`);
    }
    await x(sqlTag`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, admin_only) values
      (${ownerId}, 'team-read', 'Team reads', ${'{search_nodes,node_read}'}::text[], 'team', false),
      (${ownerId}, 'replay', 'Replay', ${'{replay_window}'}::text[], 'admin', true)`);
    await x(sqlTag`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${ownerId}, 'openrouter', ${tag}, '\\x00'::bytea)`);
    const [a] = await x<{ id: string }>(sqlTag`
      insert into agents (owner_id, slug, name, model, provider, api_key_id, system_prompt,
                          tool_group_slugs, memory_config, audience)
      values (${ownerId}, 'team-responder', 'Team', 'fake/model', 'openrouter', ${apiKeyId},
              'You answer the team.', ${'{team-read,replay}'}::text[],
              ${JSON.stringify({ digest_limit: 0 })}::jsonb, 'team')
      returning id`);
    agentId = a!.id;
    await x(sqlTag`
      insert into agents (owner_id, slug, name, role, model, provider, api_key_id, system_prompt, audience)
      values (${ownerId}, 'persona', 'Persona', 'responder', 'fake/model', 'openrouter', ${apiKeyId},
              'You are the owner''s assistant.', 'admin')`);
    await x(sqlTag`insert into skills (owner_id, slug, name, description)
      values (${ownerId}, 'check-in', 'Check in', 'Ask how things are going.')`);
    await x(sqlTag`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                           schedule_kind, schedule, surface)
      values (${ownerId}, 'team-check', 'Team check', 'team-responder', 'check-in',
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb)`);
    // The workspaces go live: the team responder becomes Team's assistant.
    await x(sqlTag`select * from mantle_ws_migrate()`);
    const [ws] = await x<{ id: string }>(
      sqlTag`select id::text as id from workspaces where owner_id = ${ownerId} and name = 'Team' and not is_admin`,
    );
    team = ws!.id;
    const [agent] = await x<{ ws: string | null }>(
      sqlTag`select workspace_id::text as ws from agents where id = ${agentId}`,
    );
    expect(agent!.ws).toBe(team);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  beforeEach(() => {
    h.calls = 0;
    h.offered = [];
    h.seenToolResults = [];
  });

  /** What the scripted turn shows: the reads only reached Team, and the
   *  adminOnly tool was never offered nor run. */
  const expectTeamOnly = () => {
    const results = h.seenToolResults.join(' ');
    // The ids the read tools handed back as items (`id` / `nodeId` fields):
    // the refused read names the asked-for id in its error, which is fine.
    const returned = [...results.matchAll(ITEM_ID_RE)].map((mm) => mm[1]!);
    expect(returned, 'the team page was read').toContain(ids.teamPage);
    expect(returned, 'an admin page reached the model').not.toContain(ids.adminPage);
    expect(results).not.toContain(`${tag} admin page`);
    expect(h.offered, 'the team read tools were offered').toContain('search_nodes');
    expect(h.offered, 'the adminOnly tool was offered').not.toContain('replay_window');
    expect(results).not.toMatch(/permission denied|turn scope|viewer level|allowlisted reason/i);
  };

  it('a heartbeat fire: tools and loop in [Team], adminOnly gone, reads only Team', async () => {
    const { forceFire } = await import('./fire');
    const [hb] = await m.systemDb
      .select()
      .from(m.heartbeats)
      .where(sqlTag`${m.heartbeats.ownerId} = ${ownerId}`);
    const res = await forceFire(hb!);
    expect(res).toMatchObject({ disposition: 'fired', replyText: 'ok, done' });
    expectTeamOnly();
    const traces = await x<{ ws: string | null }>(sqlTag`
      select workspace_id::text as ws from traces
       where kind = 'heartbeat_fire' and agent_id = ${agentId}`);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((t) => t.ws === team)).toBe(true);
  });

  it('invoke_agent of the Team assistant: the child runs in [Team]', async () => {
    const { invokeAgent } = await import('../agent/invoke-agent');
    const res = await invokeAgent({
      ownerId,
      agentSlug: 'team-responder',
      prompt: `what does the brain say about ${tag}?`,
      depth: 1,
      parentTraceId: null,
      surface: { kind: 'web' },
    } as never);
    expect(res).toMatchObject({ ok: true, text: 'ok, done' });
    expectTeamOnly();
  });

  it('inside a Team turn the Admin assistant is refused before any model call', async () => {
    const { invokeAgent } = await import('../agent/invoke-agent');
    const res = await m.withTurnScope(
      { kind: 'assistant', loginId: memberLoginId, ws: [team], modWs: [] },
      () =>
        invokeAgent({
          ownerId,
          agentSlug: 'persona',
          prompt: 'hello',
          depth: 1,
          parentTraceId: null,
          surface: { kind: 'team', loginId: memberLoginId },
        } as never),
    );
    expect(res.ok).toBe(false);
    // The workspace role does not even see the Admin assistant's row; were
    // it seen, the workspace check would refuse it.
    expect(res.ok ? '' : res.error).toMatch(/another workspace|not found/);
    expect(h.calls).toBe(0);
  });

  it('W8 final: system work delegating to a responder on no workspace is refused', async () => {
    // A responder on no workspace, made after the switch (the migration
    // gave the existing ones a workspace).
    await x(sqlTag`
      insert into agents (owner_id, slug, name, role, model, provider, api_key_id, system_prompt,
                          audience, workspace_id)
      values (${ownerId}, 'lone-responder', 'Lone', 'responder', 'fake/model', 'openrouter',
              ${apiKeyId}, 'You answer people.', 'admin', null)`);
    const { invokeAgent } = await import('../agent/invoke-agent');
    const { AgentWorkspaceError } = await import('../agent/agent-viewer');
    // No open scope and no login: a run or a heartbeat's system work.
    await expect(
      invokeAgent({
        ownerId,
        agentSlug: 'lone-responder',
        prompt: 'hello',
        depth: 1,
        parentTraceId: null,
      } as never),
    ).rejects.toBeInstanceOf(AgentWorkspaceError);
    expect(h.calls).toBe(0);
  });
});
