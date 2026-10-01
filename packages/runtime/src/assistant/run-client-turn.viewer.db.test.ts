/**
 * A REAL client turn (client logins C4, plan section 12: "a real client turn
 * cannot surface a public, team or admin item through context, facts, chunks
 * or any tool"): runClientTurn end to end on Postgres with row level
 * security on. Only the model and the API key are faked; the agent lookup,
 * the level caps, the tool resolution, the client tools, the dispatch, the
 * request filing, the thread and the trace are the production code.
 *
 * The brain holds a client page whose body mentions a team page (the chip's
 * stored label carries the team title), an OLD unredacted chunk of that page
 * (the text the index held before the level-filtered text), a team page, an
 * admin page and a public note, all with the same embedding. The client agent
 * holds its client group AND a team-level trap group with search_chunks: the
 * level cap must drop the trap.
 *
 * Seeds its own rows on the shared test anchor (unique tag), removes them by
 * id after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/assistant/run-client-turn.viewer.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  tag: '',
  ids: {} as Record<string, string>,
  calls: 0,
  offered: [] as string[][],
  modelSaw: [] as string[],
}));

vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async (id: string) => ({ id, provider: 'openrouter', key: 'sk-fake' })),
}));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))),
}));
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const chat = async (opts: {
    messages: Array<{ role: string; content?: unknown }>;
    tools?: Array<{ function?: { name?: string }; name?: string }>;
  }) => {
    h.calls += 1;
    h.offered.push((opts.tools ?? []).map((t) => t.function?.name ?? t.name ?? ''));
    // Everything that reaches the model, except its own tool-call arguments.
    for (const m of opts.messages) {
      if (m.role !== 'assistant') h.modelSaw.push(JSON.stringify(m.content ?? ''));
    }
    if (h.calls === 1) {
      return {
        text: '',
        model: 'fake/model',
        toolCalls: [
          call('t1', 'client_shared_list', { q: h.tag }),
          call('t2', 'client_shared_search', { q: 'TEAMSECRET' }),
          call('t3', 'client_shared_open', { id: h.ids.teamPage }),
          call('t4', 'client_shared_open', { id: h.ids.adminPage }),
          call('t5', 'client_shared_open', { id: h.ids.publicNote }),
          call('t6', 'client_shared_open', { id: h.ids.clientPage }),
          call('t7', 'search_chunks', { q: 'TEAMSECRET' }),
          call('t8', 'client_request_create', { title: `${h.tag} request`, body: 'Please.' }),
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

describe.skipIf(!URL)('a real client turn at client level', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let ownerId = '';
  const tag = `clientturn-${crypto.randomUUID().slice(0, 8)}`;
  const agentSlug = `client-responder-${tag}`;
  const groupSlug = `client-read-${tag}`;
  const trapSlug = `trap-${tag}`;
  const CLIENT_TOOLS = [
    'client_shared_list',
    'client_shared_search',
    'client_shared_open',
    'client_request_create',
  ];
  const apiKeyId = crypto.randomUUID();
  const loginId = crypto.randomUUID();
  let agentId = '';
  const ids = {
    clientPage: crypto.randomUUID(),
    teamPage: crypto.randomUUID(),
    adminPage: crypto.randomUUID(),
    publicNote: crypto.randomUUID(),
  };
  const filed: string[] = [];
  // Retrieval limits an admin might set: the client turn must load no context
  // WHATEVER the agent's config says (the code, not the config, is the rule).
  const RETRIEVAL_ON = { digest_limit: 0, fact_limit: 10, content_hit_limit: 5, chunk_limit: 8 };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    h.tag = tag;
    h.ids = ids;
    m = await import('@mantle/db');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    ownerId = await ensureTestAnchor(admin);
    await admin`insert into auth.users (id, email, password_hash, role, display_name)
      values (${loginId}, ${`${tag}@example.invalid`}, 'x', 'client', 'Casey Client')`;

    const vec = `[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
    await admin`insert into nodes (id, owner_id, type, title, path, audience, embedding) values
      (${ids.clientPage}, ${ownerId}, 'page', ${`${tag} client page`}, 'pages', 'client', ${vec}::vector),
      (${ids.teamPage}, ${ownerId}, 'page', ${`${tag} TEAMSECRET`}, 'pages', 'team', ${vec}::vector),
      (${ids.adminPage}, ${ownerId}, 'page', ${`${tag} ADMINSECRET`}, 'pages', 'admin', ${vec}::vector),
      (${ids.publicNote}, ${ownerId}, 'note', ${`${tag} PUBLICSECRET`}, 'notes', 'public', ${vec}::vector)`;
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The unit restarts on 12 October. See ' },
            { type: 'mention', attrs: { id: ids.teamPage, label: 'TEAMSECRET', ref: 'node' } },
          ],
        },
      ],
    };
    const empty = JSON.stringify({ type: 'doc', content: [] });
    await admin`insert into pages (node_id, doc, doc_text) values
      (${ids.clientPage}, ${JSON.stringify(doc)}::jsonb, 'The unit restarts on 12 October. See TEAMSECRET'),
      (${ids.teamPage}, ${empty}::jsonb, ''),
      (${ids.adminPage}, ${empty}::jsonb, '')`;
    // The old, unredacted index of the client page: its chunk names the team
    // item. A client turn must never read it.
    await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
      values (${ownerId}, ${ids.clientPage}, 0, ${`${tag} passage about TEAMSECRET`}, ${vec}::vector)`;

    for (const slug of [...CLIENT_TOOLS, 'search_chunks']) {
      const def = BUILTIN_TOOLS.find((t) => t.slug === slug)!;
      await admin`insert into tools (owner_id, slug, name, description, input_schema, handler)
        values (${ownerId}, ${slug}, ${def.name}, ${def.description},
                ${JSON.stringify(def.inputSchema)}::jsonb,
                ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb)
        on conflict (owner_id, slug) do nothing`;
    }
    await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience) values
      (${ownerId}, ${groupSlug}, ${tag}, ${CLIENT_TOOLS}, 'client'),
      (${ownerId}, ${trapSlug}, ${tag}, ${['search_chunks']}, 'team')`;
    await admin`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${ownerId}, 'openrouter', ${tag}, '\\x00'::bytea)`;
    const [a] = await admin<{ id: string }[]>`
      insert into agents (owner_id, slug, name, model, provider, api_key_id, system_prompt,
                          tool_group_slugs, memory_config, audience)
      values (${ownerId}, ${agentSlug}, 'Client', 'fake/model', 'openrouter', ${apiKeyId},
              'You answer the client.', ${[groupSlug, trapSlug]},
              ${JSON.stringify(RETRIEVAL_ON)}::jsonb,
              'client')
      returning id`;
    agentId = a!.id;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from team_messages where login_id = ${loginId}`;
    await admin`delete from traces where agent_id = ${agentId}`;
    await admin`delete from agents where id = ${agentId}`;
    await admin`delete from tool_groups where owner_id = ${ownerId} and slug in ${admin([groupSlug, trapSlug])}`;
    await admin`delete from api_keys where id = ${apiKeyId}`;
    for (const id of [...Object.values(ids), ...filed])
      await admin`delete from nodes where id = ${id}`;
    await admin`delete from spaces where login_id = ${loginId}`;
    await admin`delete from auth.users where id = ${loginId}`;
    await m?.closeDb();
  });

  it('completes and never shows the model a public, team or admin item, or the old chunk', async () => {
    const { runClientTurn } = await import('./run-team-turn');
    const result = await runClientTurn(ownerId, `what is shared about ${tag}?`, {
      loginId,
      agentSlug,
      contactName: 'Casey Client',
      sessionEpoch: 0,
    });
    expect(result.reply).toBe('ok, done');

    // The team-level trap group is dropped by the level cap: search_chunks is
    // never offered, and its call is refused as not in the allowlist.
    expect(h.offered[0]).toEqual(expect.arrayContaining(CLIENT_TOOLS));
    expect(h.offered[0]).not.toContain('search_chunks');

    const saw = h.modelSaw.join('\n');
    for (const leak of ['TEAMSECRET', 'ADMINSECRET', 'PUBLICSECRET']) {
      expect(saw, leak).not.toContain(leak);
    }
    // What it did read: the client page, redacted.
    expect(saw).toContain('The unit restarts on 12 October');
    expect(saw).toContain('Private item');
    expect(saw).toContain(ids.clientPage);
    for (const id of [ids.teamPage, ids.adminPage, ids.publicNote]) {
      // Ids appear only in the model's own call arguments, never in a result.
      expect(saw.includes(`"id\\":\\"${id}`), id).toBe(false);
    }
  });

  it('filed the request as a client-sourced team request with the login', async () => {
    const rows = await admin<{ id: string; data: Record<string, unknown>; tags: string[] }[]>`
      select id, data, tags from nodes where owner_id = ${ownerId} and type = 'task'
        and title = ${`${tag} request`}`;
    filed.push(...rows.map((r) => r.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags).toEqual(expect.arrayContaining(['team-request', 'client-request']));
    expect(rows[0]!.data).toMatchObject({
      source: 'client-request',
      teamRequest: { loginId, requesterRole: 'client' },
    });
  });

  it("wrote the client's own thread and a client trace", async () => {
    const msgs = await admin<{ direction: string; status: string }[]>`
      select direction, status from team_messages where login_id = ${loginId} order by created_at`;
    expect(msgs.map((r) => `${r.direction}:${r.status}`)).toEqual([
      'inbound:complete',
      'outbound:complete',
    ]);
    const [trace] = await admin<{ data: Record<string, unknown>; subject_kind: string }[]>`
      select data, subject_kind from traces where agent_id = ${agentId} and kind = 'responder_turn'`;
    expect(trace!.subject_kind).toBe('team_turn');
    expect(trace!.data).toMatchObject({
      surface: 'client',
      login_role: 'client',
      login_id: loginId,
    });
  });

  it('a stale session epoch: the turn never runs and writes nothing', async () => {
    const { runClientTurn } = await import('./run-team-turn');
    const before = h.calls;
    await expect(
      runClientTurn(ownerId, 'again', { loginId, agentSlug, sessionEpoch: 1 }),
    ).rejects.toThrow(/no longer signed in/);
    expect(h.calls).toBe(before);
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from team_messages where login_id = ${loginId}`;
    expect(row!.n).toBe(2);
  });
});
