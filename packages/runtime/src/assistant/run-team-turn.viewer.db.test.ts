/**
 * A REAL team turn in its workspace (member logins Phase 0b, plan section 2b
 * spike item 3; workspaces W5b2): runTeamTurn end to end with row level
 * security on. The test's team agent is the Team workspace's assistant (its
 * workspace_resources row, W5c: no agent level picks it), so its turn runs
 * in a Team turn scope on the workspace role, with no outer wrap. Only the model, the embedder and the API key are faked; everything
 * else (context loader, tool resolution, dispatch, traces, the team thread)
 * is the production code.
 *
 * It proves three things: the turn completes (no table the loop needs is
 * missing from the grant matrix, and infrastructure writes go through
 * systemDb); what the turn reads is only what Team holds (an admin page and
 * an admin journal entry, embedded exactly like the team page, never reach
 * the model); the trace is written.
 *
 * On a scratch brain the workspaces migration made live: a member of Team,
 * the three read tools, a team-level tool group and agent of its own, and
 * one team page, one admin page and one admin journal entry with the same
 * fixed embedding (the migration gives the team page to Team).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/assistant/run-team-turn.viewer.db.test.ts
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  vec: [] as number[],
  hiddenId: '',
  hiddenTitle: '',
  q: '',
  calls: 0,
  seenToolResults: [] as string[],
}));

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => h.vec),
  embedMany: vi.fn(async (_o: string, texts: string[]) => texts.map(() => h.vec)),
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async (id: string) => ({ id, provider: 'openrouter', key: 'sk-fake' })),
}));
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // A scripted model: first it calls three read tools (one aimed at an
  // admin-only node), then it answers.
  const chat = async (opts: { messages: Array<{ role: string; content?: unknown }> }) => {
    h.calls += 1;
    for (const m of opts.messages) {
      if (m.role === 'tool') h.seenToolResults.push(JSON.stringify(m.content));
    }
    if (h.calls === 1) {
      return {
        text: '',
        model: 'fake/model',
        toolCalls: [
          {
            id: 't1',
            type: 'function',
            function: { name: 'search_nodes', arguments: JSON.stringify({ q: h.q }) },
          },
          {
            id: 't2',
            type: 'function',
            function: { name: 'search_chunks', arguments: JSON.stringify({ q: h.q }) },
          },
          {
            id: 't3',
            type: 'function',
            function: { name: 'node_read', arguments: JSON.stringify({ node_id: h.hiddenId }) },
          },
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

/** Every item id the read tools handed the model (`id` / `nodeId` fields). */
function returnedIds(): string[] {
  return [
    ...h.seenToolResults
      .join(' ')
      .matchAll(
        /\\*"(?:id|nodeId)\\*"\s*:\s*\\*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g,
      ),
  ].map((mm) => mm[1]!);
}

describe.skipIf(!URL)('a team turn in its Team turn scope', () => {
  type Ts = typeof import('@mantle/db/test-support');
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: Db;
  let admin: Admin;
  const ownerId = crypto.randomUUID();
  let team = '';
  const tag = `teamturn-${crypto.randomUUID().slice(0, 8)}`;
  const agentSlug = `team-responder-${tag}`;
  const groupSlug = `team-read-${tag}`;
  const READ_TOOLS = ['search_nodes', 'search_chunks', 'node_read'];
  const apiKeyId = crypto.randomUUID();
  let agentId = '';
  // The member login the turns run as (the team-code contact path is retired).
  const memberLoginId = crypto.randomUUID();
  const ids = {
    teamPage: crypto.randomUUID(),
    adminPage: crypto.randomUUID(),
    journal: crypto.randomUUID(),
  };
  const adminOnly = (): string[] => [ids.adminPage, ids.journal];

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key'; // shared: roles are cluster-wide
    m = await import('@mantle/db');
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    // The admin pool's own postgres-js client, for setup.
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, is_owner, role)
      values (${ownerId}, ${`owner-${tag}@example.invalid`}, 'x', true, 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${ownerId}, 'brain', ${ownerId})
      on conflict (id) do nothing`;
    await admin`insert into auth.users (id, email, password_hash, role)
      values (${memberLoginId}, ${`member-${memberLoginId.slice(0, 8)}@example.invalid`}, 'x',
              'member')`;

    // A fixed embedding: every seeded item is equally close to the query, so
    // only the level decides what comes back.
    h.vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    h.q = tag;
    const vec = `[${h.vec.join(',')}]`;
    h.hiddenId = ids.journal;
    h.hiddenTitle = `${tag} admin journal entry`;
    await admin`insert into nodes (id, owner_id, type, title, path, audience, embedding) values
      (${ids.teamPage}, ${ownerId}, 'page', ${`${tag} team page`}, 'pages', 'team', ${vec}::vector),
      (${ids.adminPage}, ${ownerId}, 'page', ${`${tag} admin page`}, 'pages', 'admin', ${vec}::vector),
      (${ids.journal}, ${ownerId}, 'journal', ${h.hiddenTitle}, 'journal', 'admin', ${vec}::vector)`;
    for (const [n, id] of Object.values(ids).entries()) {
      await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${ownerId}, ${id}, ${n}, ${`${tag} passage ${n}`}, ${vec}::vector)`;
    }

    // The agent's tools, group, key and the agent itself.
    for (const slug of READ_TOOLS) {
      const def = BUILTIN_TOOLS.find((t) => t.slug === slug)!;
      await admin`insert into tools (owner_id, slug, name, description, input_schema, handler)
        values (${ownerId}, ${slug}, ${def.name}, ${def.description},
                ${JSON.stringify(def.inputSchema)}::jsonb,
                ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb)
        on conflict (owner_id, slug) do nothing`;
    }
    await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience)
      values (${ownerId}, ${groupSlug}, ${tag}, ${READ_TOOLS}, 'team')`;
    await admin`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${ownerId}, 'openrouter', ${tag}, '\\x00'::bytea)`;
    const [a] = await admin<{ id: string }[]>`
      insert into agents (owner_id, slug, name, model, provider, api_key_id, system_prompt,
                          tool_group_slugs, memory_config, audience)
      values (${ownerId}, ${agentSlug}, 'Team', 'fake/model', 'openrouter', ${apiKeyId},
              'You answer the team.', ${[groupSlug]},
              ${JSON.stringify({ digest_limit: 0 })}::jsonb, 'team')
      returning id`;
    agentId = a!.id;
    // Live workspaces: the team page to Team, the admin items to Admin only,
    // the member a user of Team. The agent answers in Team.
    await m.systemDb.execute(sql`select * from mantle_ws_migrate()`);
    const [t] = await admin<{ id: string }[]>`
      select id::text as id from workspaces where owner_id = ${ownerId} and bridge_key = 'team'`;
    team = t!.id;
    // The Team workspace's assistant (the resource trigger writes
    // agents.workspace_id).
    await admin`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${team}, 'assistant', ${agentId}, true)`;
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('completes, reads only what Team holds, and writes its trace', async () => {
    const { runTeamTurn } = await import('./run-team-turn');
    // No outer wrap: the agent's workspace alone puts the turn in Team's scope.
    const result = await runTeamTurn(ownerId, `what does the brain say about ${tag}?`, {
      loginId: memberLoginId,
      agentSlug,
    });
    expect(result.reply).toBe('ok, done');

    // Every item a read tool handed the model (its `id` / `nodeId` fields).
    // Ids inside visible TEXT (a page linking a task) are references, not
    // reads, so they are not counted.
    const returned = returnedIds();
    expect(returned, 'the read tools returned the team page').toContain(ids.teamPage);
    expect(
      returned.filter((id) => adminOnly().includes(id)),
      'admin items reached the model',
    ).toEqual([]);
    // Nothing returned is outside what Team holds.
    const outside = await admin<{ id: string }[]>`
      select id from nodes where id in ${admin(returned)}
        and (not (${team}::uuid = any(read_ws)) or owner_id <> ${ownerId})`;
    expect(outside, 'items Team does not hold').toEqual([]);
    // The admin-only journal entry, asked for by id, never reached the model.
    expect(h.seenToolResults.join(' ')).not.toContain(h.hiddenTitle);

    // The trace landed (systemDb).
    const traces = (await m.systemDb.execute(
      sql`select count(*)::int as n from traces where kind = 'responder_turn' and agent_id = ${agentId}`,
    )) as unknown as { n: number }[];
    expect(traces[0]!.n).toBeGreaterThan(0);
  });

  it('a member LOGIN with no contact chats: its rows carry the login, not a contact', async () => {
    // Users are the team (0167): a member login needs no contact.
    const loginId = crypto.randomUUID();
    await admin`insert into auth.users (id, email, password_hash, role)
      values (${loginId}, ${`member-${loginId.slice(0, 8)}@example.invalid`}, 'x', 'member')`;
    // A user of Team (an admin added it): the assistant's workspace.
    await admin`insert into workspace_users (workspace_id, login_id, moderator)
      values (${team}, ${loginId}, false)`;
    try {
      const { runTeamTurn } = await import('./run-team-turn');
      const result = await runTeamTurn(ownerId, 'hello from a member', {
        loginId,
        contactName: 'Test Member',
        agentSlug,
      });
      expect(result.reply).toBe('ok, done');
      const rows = await admin<{ direction: string; contact_id: string | null }[]>`
        select direction, contact_id from team_messages where login_id = ${loginId}
        order by created_at`;
      expect(rows.map((r) => [r.direction, r.contact_id])).toEqual([
        ['inbound', null],
        ['outbound', null],
      ]);
    } finally {
      await admin`delete from team_messages where login_id = ${loginId}`;
    }
  });

  // W5c: the agent is the Team workspace's assistant, never one picked by
  // its level. Another agent, even one at team level, is refused outright.
  it('control: an agent that is not the Team workspace’s assistant is refused outright', async () => {
    const otherSlug = `other-${tag}`;
    await admin`
      insert into agents (owner_id, slug, name, model, provider, api_key_id, system_prompt,
                          tool_group_slugs, memory_config, audience)
      values (${ownerId}, ${otherSlug}, 'Other', 'fake/model', 'openrouter', ${apiKeyId},
              'Other.', ${[groupSlug]}, ${JSON.stringify({ digest_limit: 0 })}::jsonb, 'team')`;
    h.calls = 0;
    h.seenToolResults = [];
    try {
      const { runTeamTurn } = await import('./run-team-turn');
      await expect(
        runTeamTurn(ownerId, 'what does the brain say about itself?', {
          loginId: memberLoginId,
          agentSlug: otherSlug,
        }),
      ).rejects.toThrow(/not the Team workspace's assistant/);
      expect(h.calls).toBe(0);
      expect(h.seenToolResults).toEqual([]);
    } finally {
      await admin`delete from agents where owner_id = ${ownerId} and slug = ${otherSlug}`;
    }
  });

  it('the Team workspace’s assistant answers whatever level it still stores, and reads only Team', async () => {
    // Levels are frozen since 0268 (W7b): set past the freeze.
    const setLevel = (level: string) =>
      admin.begin(async (tx) => {
        await tx`select mantle_heads_bypass('test fixture')`;
        await tx`update agents set audience = ${level} where id = ${agentId}`;
      });
    await setLevel('admin');
    h.calls = 0;
    h.seenToolResults = [];
    try {
      const { runTeamTurn } = await import('./run-team-turn');
      const result = await runTeamTurn(ownerId, `what does the brain say about ${tag}?`, {
        loginId: memberLoginId,
      });
      expect(result.reply).toBe('ok, done');
      expect(returnedIds().filter((id) => adminOnly().includes(id))).toEqual([]);
      expect(h.seenToolResults.join(' ')).not.toContain(h.hiddenTitle);
    } finally {
      await setLevel('team');
    }
  });
});
