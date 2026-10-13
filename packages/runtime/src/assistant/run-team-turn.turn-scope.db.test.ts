/**
 * A REAL Team assistant turn in its workspace scope (workspaces W4b):
 * runTeamTurn end to end, its agent attached to the Team workspace by the
 * workspaces migration, so the turn runs on the workspace role with the scope
 * [Team] (per-query transactions). Only the model, the embedder and the API
 * key are faked. It proves the turn completes (every table the loop reads has
 * a rule for the workspace role), reads only what Team holds (an admin page
 * and an admin journal entry with the same embedding never reach the model),
 * and stamps its trace with Team and the member's login (R3).
 *
 * On a scratch database of its own: the workspaces migration is per brain.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/assistant/run-team-turn.turn-scope.db.test.ts
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

describe.skipIf(!URL)('a Team assistant turn in its workspace scope (W4b)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  const ownerId = crypto.randomUUID();
  const memberLoginId = crypto.randomUUID();
  const tag = `wsturn-${ownerId.slice(0, 8)}`;
  const READ_TOOLS = ['search_nodes', 'search_chunks', 'node_read'];
  const apiKeyId = crypto.randomUUID();
  let agentId = '';
  let team = '';
  const ids = {
    teamPage: crypto.randomUUID(),
    adminPage: crypto.randomUUID(),
    journal: crypto.randomUUID(),
  };
  const adminOnly = (): string[] => [ids.adminPage, ids.journal];
  const x = async <T>(q: ReturnType<typeof import('drizzle-orm').sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

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
    const vec = `[${h.vec.join(',')}]`;
    h.hiddenId = ids.journal;
    h.hiddenTitle = `${tag} admin journal entry`;
    await x(sqlTag`insert into nodes (id, owner_id, type, title, path, audience, embedding) values
      (${ids.teamPage}, ${ownerId}, 'page', ${`${tag} team page`}, 'pages', 'team', ${vec}::vector),
      (${ids.adminPage}, ${ownerId}, 'page', ${`${tag} admin page`}, 'pages', 'admin', ${vec}::vector),
      (${ids.journal}, ${ownerId}, 'journal', ${h.hiddenTitle}, 'journal', 'admin', ${vec}::vector)`);
    let n = 0;
    for (const id of Object.values(ids)) {
      await x(sqlTag`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${ownerId}, ${id}, ${n}, ${`${tag} passage ${n}`}, ${vec}::vector)`);
      n += 1;
    }
    for (const slug of READ_TOOLS) {
      const def = BUILTIN_TOOLS.find((t) => t.slug === slug)!;
      await x(sqlTag`insert into tools (owner_id, slug, name, description, input_schema, handler)
        values (${ownerId}, ${slug}, ${def.name}, ${def.description},
                ${JSON.stringify(def.inputSchema)}::jsonb,
                ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb)`);
    }
    await x(sqlTag`insert into tool_groups (owner_id, slug, name, tool_slugs, audience)
      values (${ownerId}, 'team-read', 'Team reads', ${`{${READ_TOOLS.join(',')}}`}::text[], 'team')`);
    await x(sqlTag`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${ownerId}, 'openrouter', ${tag}, '\\x00'::bytea)`);
    const [a] = await x<{ id: string }>(sqlTag`
      insert into agents (owner_id, slug, name, model, provider, api_key_id, system_prompt,
                          tool_group_slugs, memory_config, audience)
      values (${ownerId}, 'team-responder', 'Team', 'fake/model', 'openrouter', ${apiKeyId},
              'You answer the team.', ${'{team-read}'}::text[],
              ${JSON.stringify({ digest_limit: 0 })}::jsonb, 'team')
      returning id`);
    agentId = a!.id;
    // The workspaces go live: the team responder becomes Team's assistant.
    await x(sqlTag`select * from mantle_ws_migrate()`);
    const [ws] = await x<{ id: string }>(
      sqlTag`select id::text as id from workspaces where owner_id = ${ownerId} and name = 'Team' and not is_admin`,
    );
    team = ws!.id;
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('is attached to Team, completes, reads only what Team holds, and stamps its trace', async () => {
    const [agent] = await x<{ ws: string | null }>(
      sqlTag`select workspace_id::text as ws from agents where id = ${agentId}`,
    );
    expect(agent!.ws).toBe(team);
    const { runTeamTurn } = await import('./run-team-turn');
    const result = await runTeamTurn(ownerId, `what does the brain say about ${tag}?`, {
      loginId: memberLoginId,
      agentSlug: 'team-responder',
    });
    expect(result.reply).toBe('ok, done');
    const returned = returnedIds();
    expect(returned, 'the read tools returned the team page').toContain(ids.teamPage);
    expect(
      returned.filter((id) => adminOnly().includes(id)),
      'admin items reached the model',
    ).toEqual([]);
    expect(h.seenToolResults.join(' ')).not.toContain(h.hiddenTitle);
    // No tool met a missing read rule or a lost scope.
    expect(h.seenToolResults.join(' ')).not.toMatch(/permission denied|turn scope|viewer level/i);
    const traces = await x<{ ws: string | null; login: string | null }>(sqlTag`
      select workspace_id::text as ws, login_id::text as login from traces
       where kind = 'responder_turn' and agent_id = ${agentId}`);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((t) => t.ws === team && t.login === memberLoginId)).toBe(true);
  });
});
