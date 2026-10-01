/**
 * A REAL team turn under the team viewer role (member logins Phase 0b, plan
 * section 2b spike item 3): runTeamTurn end to end with row level security
 * on. The switch is the agent's level alone: the test's team agent is at
 * `team` and the turn is called with no outer wrap. Only the model, the
 * embedder and the API key are faked; everything else (context loader, tool
 * resolution, dispatch, traces, the team thread) is the production code on
 * the limited pool.
 *
 * It proves three things: the turn completes (no table the loop needs is
 * missing from the grant matrix, and infrastructure writes go through
 * systemDb); what the team role reads is only team-visible (an admin page
 * and an admin journal entry, embedded exactly like the team page, never
 * reach the model); the trace is written.
 *
 * It seeds its own minimal brain on the shared test database (so it runs in
 * CI): the shared anchor, an API key row, the three read tools, a team-level
 * tool group and agent of its own (a unique slug, so the brain's
 * team-responder is never touched), and one team page, one admin page and one
 * admin journal entry with the same fixed embedding. It removes them after
 * (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/assistant/run-team-turn.viewer.db.test.ts
 */
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

describe.skipIf(!URL)('a team turn under the team viewer role', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let sqlTag: typeof import('drizzle-orm').sql;
  let ownerId = '';
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
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key'; // shared: roles are cluster-wide
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    // The admin pool's own postgres-js client, for setup.
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    ownerId = await ensureTestAnchor(admin);
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
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from team_messages where login_id = ${memberLoginId}`;
    await admin`delete from traces where agent_id = ${agentId}`;
    await admin`delete from agents where id = ${agentId}`;
    await admin`delete from tool_groups where owner_id = ${ownerId} and slug = ${groupSlug}`;
    await admin`delete from api_keys where id = ${apiKeyId}`;
    await admin`delete from nodes where id in ${admin(Object.values(ids))}`;
    await admin`delete from spaces where login_id = ${memberLoginId}`;
    await admin`delete from auth.users where id = ${memberLoginId}`;
    await m?.closeDb();
  });

  it('completes, reads only team-visible items, and writes its trace', async () => {
    const { runTeamTurn } = await import('./run-team-turn');
    // No outer wrap: the agent's level alone puts the turn on the team role.
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
    // Whatever else the brain holds (other test files write to it), nothing
    // returned is above the team level.
    const above = await admin<{ id: string }[]>`
      select id from nodes where id in ${admin(returned)}
        and (audience = 'admin' or owner_id <> ${ownerId} or not mantle_workspace_kind(type))`;
    expect(above, 'items outside the team level').toEqual([]);
    // The admin-only journal entry, asked for by id, never reached the model.
    expect(h.seenToolResults.join(' ')).not.toContain(h.hiddenTitle);

    // The trace landed (systemDb).
    const traces = (await m.systemDb.execute(
      sqlTag`select count(*)::int as n from traces where kind = 'responder_turn' and agent_id = ${agentId}`,
    )) as unknown as { n: number }[];
    expect(traces[0]!.n).toBeGreaterThan(0);
  });

  it('a member LOGIN with no contact chats: its rows carry the login, not a contact', async () => {
    // Users are the team (0167): a member login needs no contact.
    const loginId = crypto.randomUUID();
    await admin`insert into auth.users (id, email, password_hash, role)
      values (${loginId}, ${`member-${loginId.slice(0, 8)}@example.invalid`}, 'x', 'member')`;
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
      await admin`delete from spaces where login_id = ${loginId}`;
      await admin`delete from auth.users where id = ${loginId}`;
    }
  });

  // The old control ran the same turn at admin for a portal contact and saw
  // admin-only items. That path is retired (Phase 6): a member login is never
  // served by an admin-level agent at all.
  it('control: with the agent at admin, a member turn is refused outright', async () => {
    await admin`update agents set audience = 'admin' where id = ${agentId}`;
    h.calls = 0;
    h.seenToolResults = [];
    try {
      const { runTeamTurn } = await import('./run-team-turn');
      await expect(
        runTeamTurn(ownerId, 'what does the brain say about itself?', {
          loginId: memberLoginId,
          agentSlug,
        }),
      ).rejects.toThrow(/admin level/);
      expect(h.seenToolResults).toEqual([]);
    } finally {
      await admin`update agents set audience = 'team' where id = ${agentId}`;
    }
  });
});
