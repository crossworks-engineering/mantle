/**
 * Workspace delegation (owner decision 2026-10-26): the assistant of a
 * workspace other than Admin hands work to Draftsman (diagrammer),
 * Presenter (presenter) or Appsmith (appsmith), and the specialist runs with
 * the MEMBER's own rights in the turn's workspace, never Admin's. On one
 * migrated scratch database, switched to workspaces, the manifest applied,
 * with the actor check and the edit check on, through the real path: a
 * member's runTeamTurn of W's assistant, its tool loop, invoke_agent (the
 * delegation gateway), the runtime invoker and the child's own tool loop.
 * Only the model, the embedder and the API key are faked: a scripted model
 * per agent (each agent's prompt carries its marker).
 *
 *  - Presenter: a canvas made by the child lands where the member's own
 *    create in W's turn lands (its private workspace for a plain user of W,
 *    W for a Moderator); a canvas in X (a workspace the member moderates),
 *    in Admin or in another user's own workspace is neither read, edited
 *    nor restored, each answered as a random uuid is, and left unchanged;
 *  - Draftsman: a page made the same way; a page in X is not read or
 *    changed;
 *  - Appsmith: an app made in W by a Moderator (at team rules, the member
 *    its author); an app in X is not changed; its own hand-off to the
 *    Toolsmith is refused in a workspace turn;
 *  - a delegation to a slug off the workspace list (toolsmith, researcher,
 *    pages) from a workspace turn is refused, and no child runs;
 *  - the child's tools hold no adminOnly tool and no owner-only one the
 *    workspace turn may not run; its prompt is its own (system + the
 *    hand-off), with no owner identity, Journal or persona notes;
 *  - the child's trace says it is a workspace delegation (surface `team`,
 *    the member's login);
 *  - the Admin persona's delegation is unchanged (it still reaches the
 *    researcher).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/ws-delegation.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Call = { id: string; name: string; args: Record<string, unknown> };
type Reply = { calls?: Call[]; text?: string };
type Msg = { role: string; content?: unknown; toolCallId?: string };

const h = vi.hoisted(() => ({
  vec: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
  /** Each agent's scripted replies, by its prompt marker; empty: it answers. */
  script: {} as Record<string, Reply[]>,
  /** Tool results the model was handed, by call id. */
  results: {} as Record<string, string>,
  /** The tool names each agent was offered, and every message it saw. */
  offered: {} as Record<string, Set<string>>,
  firstMessages: {} as Record<string, Msg[]>,
  allText: [] as string[],
  calls: {} as Record<string, number>,
}));

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => h.vec),
  embedMany: vi.fn(async (_o: string, texts: string[]) => texts.map(() => h.vec)),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => h.vec)),
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async (id: string) => ({ id, provider: 'openrouter', key: 'sk-fake' })),
  resolveProviderKey: vi.fn(async () => 'sk-fake'),
}));
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const text = (c: unknown): string =>
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.map((p) => (p as { text?: string }).text ?? '').join(' ')
        : '';
  const chat = async (opts: { messages: Msg[]; tools?: unknown }) => {
    const system = text(opts.messages.find((m) => m.role === 'system')?.content);
    const who = /MARK:([a-z0-9-]+)/.exec(system)?.[1] ?? 'unknown';
    h.calls[who] = (h.calls[who] ?? 0) + 1;
    if (h.calls[who] === 1) h.firstMessages[who] = [...opts.messages];
    const offered = (h.offered[who] ??= new Set());
    for (const t of (opts.tools ?? []) as Array<{ name?: string; function?: { name?: string } }>) {
      offered.add(t.function?.name ?? t.name ?? '');
    }
    for (const m of opts.messages) {
      h.allText.push(text(m.content));
      if (m.role === 'tool' && m.toolCallId) h.results[m.toolCallId] = text(m.content);
    }
    const next = h.script[who]?.shift();
    if (next?.calls?.length) {
      return {
        text: '',
        model: 'fake/model',
        toolCalls: next.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
    return { text: next?.text ?? `${who} done`, model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake-chat', chat })),
  };
});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A hidden item answers as a random uuid does, the id aside. */
const noIds = (s: string) => s.replace(UUID_RE, '<id>');
const canvas = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;

describe.skipIf(!URL)('a workspace assistant delegates with the member’s own rights', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('@mantle/tools');
  let runTeamTurn: typeof import('@mantle/runtime/assistant').runTeamTurn;
  let manifest: typeof import('../lib/system-manifest/manifest');
  let dir = '';
  const tag = `wsd${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  /** A Moderator of W. */
  const mod = randomUUID();
  /** A plain user of W who moderates X. */
  const user = randomUUID();
  /** A member with a workspace of its own only. */
  const other = randomUUID();
  const apiKeyId = randomUUID();
  const ws = { admin: '', w: '', x: '', userOwn: '', otherOwn: '', modOwn: '' };
  const wsa = `${tag}-wsa`;
  const item = { cvX: '', cvAdmin: '', cvOther: '', pageX: '', appX: '' };
  const journalToken = `${tag}-owner-journal-secret`;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  /** Make an item homed in `home` alone, as the system. */
  const homed = async (home: string, make: () => Promise<{ id: string }>) => {
    const row = await m.asSystem(
      () => m.withCreateHome({ createWs: home, privateWs: null, quiet: true }, make),
      'test',
    );
    await m.withHeads([row.id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${row.id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${row.id}, ${home}, true, true)`);
    });
    return row.id;
  };
  const titleOf = async (id: string) =>
    (await x<{ t: string }>(sql`select title as t from nodes where id = ${id}`))[0]?.t;
  /** The home of the newest item of `type` whose title holds `token`. */
  const homeOf = async (type: string, token: string) =>
    (
      await x<{ home: string | null }>(sql`
        select g.workspace_id::text as home from nodes n
          left join item_grants g on g.node_id = n.id and g.is_home
         where n.type = ${type} and n.title ilike ${`%${token}%`}
         order by n.created_at desc limit 1`)
    )[0]?.home ?? null;
  const madeCount = async (token: string) =>
    (
      await x<{ n: number }>(
        sql`select count(*)::int as n from nodes where title ilike ${`%${token}%`}`,
      )
    )[0]!.n;

  /** One member turn of W's assistant: it hands `prompt` to `slug`. */
  const delegate = async (login: string, slug: string, childScript: Reply[]) => {
    h.script = {
      wsa: [
        {
          calls: [
            {
              id: `${tag}-p1`,
              name: 'invoke_agent',
              args: { agent_slug: slug, prompt: `please, ${tag}` },
            },
          ],
        },
        { text: 'parent done' },
      ],
      [slug]: childScript,
    };
    const res = await runTeamTurn(owner, `please, ${tag}`, { loginId: login, agentSlug: wsa });
    return { reply: res.reply, handOff: h.results[`${tag}-p1`] ?? '' };
  };
  /** The tools only an adminOnly group holds (a tool in a system-wide group
   *  too is the workspace's to call). */
  const adminOnlyTools = () => {
    const admin = new Set<string>();
    const open = new Set<string>();
    for (const g of manifest.MANIFEST_TOOL_GROUPS) {
      const into = manifest.MANIFEST_ADMIN_ONLY_GROUPS.includes(g.slug) ? admin : open;
      for (const t of g.toolSlugs) into.add(t);
    }
    return new Set([...admin].filter((t) => !open.has(t)));
  };
  /** The child offered nothing adminOnly, and no owner-only tool but the app
   *  tools a login's workspace turn runs (`loginTurns`). */
  const expectChildToolsScoped = (who: string) => {
    const offered = [...(h.offered[who] ?? [])];
    expect(offered.length, `${who} was offered tools`).toBeGreaterThan(0);
    const adminOnly = adminOnlyTools();
    expect(adminOnly.has('email_list') && adminOnly.has('replay_window')).toBe(true);
    expect(offered.filter((t) => adminOnly.has(t))).toEqual([]);
    const ownerOnly = tools.BUILTIN_TOOLS.filter((d) => d.ownerOnly && !d.loginTurns).map(
      (d) => d.slug,
    );
    expect(offered.filter((t) => ownerOnly.includes(t))).toEqual([]);
  };
  /** The child's own prompt: its system block and the hand-off, nothing of
   *  the owner's. */
  const expectChildPromptOwn = (who: string) => {
    const first = h.firstMessages[who]!;
    expect(first.map((mm) => mm.role)).toEqual(['system', 'user']);
    const all = JSON.stringify(first);
    expect(all).toContain(`MARK:${who}`);
    expect(all).not.toContain(journalToken);
    expect(all).not.toMatch(/# Working notes|About the user/);
    expect(h.allText.join(' ')).not.toContain(journalToken);
  };
  const childTrace = async (slug: string) =>
    (
      await x<{ data: Record<string, unknown>; login: string | null }>(sql`
        select data, login_id::text as login from traces
         where kind = 'manual' and subject_kind = 'child_agent'
           and data->>'delegated_agent_slug' = ${slug}
         order by started_at desc limit 1`)
    )[0];

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'ws-delegation-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_DETACHED_DEV;
    // No renderer, no outside: a canvas save says it was not drawn.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    );
    m = await import('@mantle/db');
    tools = await import('@mantle/tools');
    manifest = await import('../lib/system-manifest/manifest');
    const { invokeAgent } = await import('@mantle/runtime/agent');
    tools.registerAgentInvoker(invokeAgent);
    runTeamTurn = (await import('@mantle/runtime/assistant')).runTeamTurn;
    const seed = await import('../lib/system-manifest/seed');
    const { createPresent } = await import('@mantle/content/presents');
    const { createPage } = await import('@mantle/content/pages');
    const { createApp } = await import('@mantle/content');

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mod}, ${`${tag}-mod@example.invalid`}, 'x', false, 'member', 'Mod'),
      (${user}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'User'),
      (${other}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Other')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`);
    await m.asSystem(() => seed.applyManifest(owner), 'test');
    await ts.runWorkspacesSwitch();
    ws.admin = (
      await x<{ id: string }>(sql`select id::text as id from workspaces
        where owner_id = ${owner} and is_admin`)
    )[0]!.id;
    const mk = async (name: string) =>
      (
        await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${name}`}) returning id::text as id`)
      )[0]!.id;
    ws.w = await mk('W');
    ws.x = await mk('X');
    await su(sql`delete from workspace_users where workspace_id in (${ws.w}, ${ws.x})`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.w}, ${mod}, true), (${ws.w}, ${user}, false), (${ws.x}, ${user}, true)`);
    const own = async (login: string) => {
      await x(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${login}, true)::uuid)`,
      );
      return (
        await x<{ ws: string }>(sql`select workspace_id::text as ws from private_workspaces
          where login_id = ${login}`)
      )[0]!.ws;
    };
    ws.userOwn = await own(user);
    ws.otherOwn = await own(other);
    ws.modOwn = await own(mod);

    // W's assistant: copied from the persona long ago, its delegate_to names
    // every specialist (wireDelegation); only the workspace delegates count.
    const [wa] = await x<{ id: string }>(sql`
      insert into agents (owner_id, slug, name, role, model, provider, api_key_id, system_prompt,
                          tool_group_slugs, memory_config, workspace_id)
      values (${owner}, ${wsa}, 'W assistant', 'assistant', 'fake/model', 'openrouter', ${apiKeyId},
              'MARK:wsa You answer W.', ${'{memory-core,delegation}'}::text[],
              ${JSON.stringify({
                digest_limit: 0,
                delegate_to: [
                  'researcher',
                  'pages',
                  'toolsmith',
                  'diagrammer',
                  'presenter',
                  'appsmith',
                ],
              })}::jsonb, ${ws.w})
      returning id::text as id`);
    await su(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${ws.w}, 'assistant', ${wa!.id}, true)`);
    // Each specialist answers with its own scripted model.
    for (const slug of [
      'diagrammer',
      'presenter',
      'appsmith',
      'toolsmith',
      'researcher',
      'pages',
    ]) {
      await x(sql`update agents set system_prompt = ${`MARK:${slug} You are ${slug}.`},
        model = 'fake/model', provider = 'openrouter', api_key_id = ${apiKeyId}
        where owner_id = ${owner} and slug = ${slug}`);
    }
    // An owner gave each workspace delegate an adminOnly group (mail, the
    // Journal, replay): a workspace turn's child must drop it.
    await x(sql`update agents set tool_group_slugs = tool_group_slugs || ${'{email,journal,replay}'}::text[]
      where owner_id = ${owner} and slug in ('diagrammer', 'presenter', 'appsmith')`);
    // The owner's private context a child must never carry.
    await x(sql`insert into nodes (owner_id, type, title, path, audience)
      values (${owner}, 'journal', ${journalToken}, 'journal', 'admin')`);

    item.cvX = await homed(ws.x, () =>
      createPresent(owner, { source: canvas(`${tag} cv x`), css: '' }),
    );
    item.cvAdmin = await homed(ws.admin, () =>
      createPresent(owner, { source: canvas(`${tag} cv admin`), css: '' }),
    );
    item.cvOther = await homed(ws.otherOwn, () =>
      createPresent(owner, { source: canvas(`${tag} cv other`), css: '' }),
    );
    item.pageX = await homed(ws.x, () => createPage(owner, { title: `${tag} page x` }));
    item.appX = await homed(ws.x, () => createApp(owner, { title: `${tag} app x` }));

    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    h.results = {};
    h.offered = {};
    h.firstMessages = {};
    h.allText = [];
    h.calls = {};
  });

  /** Each of `ids` asked by `make(id)` and by a random uuid: the results,
   *  the id aside, are the same, and refusals. */
  const hiddenAsRandom = (prefix: string, names: string[]) => {
    const random = h.results[`${prefix}-random`];
    expect(random, `${prefix} on a random id answered`).toMatch(/not found/);
    for (const n of names) {
      const hidden = h.results[`${prefix}-${n}`];
      expect(hidden, `${prefix} ${n} answered`).toBeDefined();
      expect(noIds(hidden!), `${n} answers as a random id`).toBe(noIds(random!));
    }
  };

  it('Presenter for a plain user of W: the canvas lands in its own workspace; X, Admin and another user’s are out of reach', async () => {
    const token = `${tag}c${randomUUID().slice(0, 6)}`;
    const targets: Record<string, string> = {
      x: item.cvX,
      admin: item.cvAdmin,
      other: item.cvOther,
      random: randomUUID(),
    };
    const before = Object.fromEntries(
      await Promise.all(Object.entries(targets).map(async ([k, id]) => [k, await titleOf(id)])),
    );
    const calls: Call[] = [
      {
        id: 'c-make',
        name: 'present_create',
        args: { title: token, source: canvas(token), look: false },
      },
    ];
    for (const [k, id] of Object.entries(targets)) {
      calls.push({ id: `get-${k}`, name: 'present_get', args: { id } });
      calls.push({ id: `upd-${k}`, name: 'present_update', args: { id, title: `${tag} hijack` } });
      calls.push({ id: `rst-${k}`, name: 'present_restore', args: { id, rev: 1 } });
    }
    const { reply, handOff } = await delegate(user, 'presenter', [{ calls }, { text: 'made it' }]);
    expect(reply).toBe('parent done');
    expect(handOff).toContain('made it');
    expect(h.results['c-make'], h.results['c-make']).not.toMatch(/"ok":\s*false|error/i);
    expect(await homeOf('present', token)).toBe(ws.userOwn);
    for (const p of ['get', 'upd', 'rst']) hiddenAsRandom(p, ['x', 'admin', 'other']);
    for (const [k, id] of Object.entries(targets)) {
      if (k !== 'random') expect(await titleOf(id), k).toBe(before[k]);
    }
    expectChildToolsScoped('presenter');
    expectChildPromptOwn('presenter');
    const trace = await childTrace('presenter');
    expect(trace?.data).toMatchObject({
      workspace_delegation: true,
      surface: 'team',
      login_id: user,
    });
    expect(trace?.login).toBe(user);
    expect(m.takeActorMisses()).toEqual([]);
  }, 180_000);

  it('Presenter for a Moderator of W: the canvas lands in W', async () => {
    const token = `${tag}c${randomUUID().slice(0, 6)}`;
    await delegate(mod, 'presenter', [
      {
        calls: [
          {
            id: 'c-make',
            name: 'present_create',
            args: { title: token, source: canvas(token), look: false },
          },
        ],
      },
      { text: 'made it' },
    ]);
    expect(await homeOf('present', token)).toBe(ws.w);
    expect(m.takeActorMisses()).toEqual([]);
  }, 180_000);

  it('Draftsman: a page lands where the member’s own create lands; a page in X is out of reach', async () => {
    const token = `${tag}p${randomUUID().slice(0, 6)}`;
    const before = await titleOf(item.pageX);
    const random = randomUUID();
    await delegate(user, 'diagrammer', [
      {
        calls: [
          { id: 'p-make', name: 'page_create', args: { title: token, markdown: `# ${token}` } },
          { id: 'get-x', name: 'page_get', args: { id: item.pageX } },
          { id: 'get-random', name: 'page_get', args: { id: random } },
          {
            id: 'upd-x',
            name: 'page_update_draft',
            args: { id: item.pageX, title: `${tag} hijack` },
          },
          {
            id: 'upd-random',
            name: 'page_update_draft',
            args: { id: random, title: `${tag} hijack` },
          },
        ],
      },
      { text: 'drawn' },
    ]);
    expect(await homeOf('page', token)).toBe(ws.userOwn);
    hiddenAsRandom('get', ['x']);
    hiddenAsRandom('upd', ['x']);
    expect(await titleOf(item.pageX)).toBe(before);
    expectChildToolsScoped('diagrammer');
    expectChildPromptOwn('diagrammer');
    expect(m.takeActorMisses()).toEqual([]);
  }, 180_000);

  it('Appsmith: a Moderator’s app lands in W at team rules; an app in X is out of reach; its Toolsmith hand-off is refused', async () => {
    const token = `${tag}a${randomUUID().slice(0, 6)}`;
    const before = await titleOf(item.appX);
    const random = randomUUID();
    await delegate(mod, 'appsmith', [
      {
        calls: [
          { id: 'a-make', name: 'app_create', args: { name: token } },
          { id: 'upd-x', name: 'app_update', args: { id: item.appX, name: `${tag} hijack` } },
          { id: 'upd-random', name: 'app_update', args: { id: random, name: `${tag} hijack` } },
          {
            id: 'a-nested',
            name: 'invoke_agent',
            args: { agent_slug: 'toolsmith', prompt: 'make me a data tool' },
          },
        ],
      },
      { text: 'built' },
    ]);
    expect(h.results['a-make'], h.results['a-make']).toContain(token);
    expect(await homeOf('app', token)).toBe(ws.w);
    const [app] = await x<{ level: string | null; author: string | null }>(sql`
      select a.author_level as level, a.author_login_id::text as author from apps a
        join nodes n on n.id = a.node_id where n.title = ${token}`);
    expect(app).toEqual({ level: 'team', author: mod });
    hiddenAsRandom('upd', ['x']);
    expect(await titleOf(item.appX)).toBe(before);
    expect(h.results['a-nested']).toMatch(/cannot be delegated to from a workspace/);
    expect(h.calls.toolsmith ?? 0).toBe(0);
    expectChildToolsScoped('appsmith');
    expect(m.takeActorMisses()).toEqual([]);
  }, 180_000);

  it.each(['toolsmith', 'researcher', 'pages'])(
    'a hand-off to %s from a workspace turn is refused, and no child runs',
    async (slug) => {
      const { reply, handOff } = await delegate(user, slug, [{ text: 'should not run' }]);
      expect(reply).toBe('parent done');
      expect(handOff).toMatch(/cannot be delegated to from a workspace/);
      expect(h.calls[slug] ?? 0).toBe(0);
      expect(await madeCount('should not run')).toBe(0);
      expect(m.takeActorMisses()).toEqual([]);
    },
    120_000,
  );

  it('the W assistant is shown the workspace delegates only', async () => {
    await delegate(user, 'presenter', [{ text: 'ok' }]);
    expect(h.offered.wsa?.has('invoke_agent')).toBe(true);
    const first = JSON.stringify(h.firstMessages.wsa ?? []);
    expect(first).not.toMatch(/\btoolsmith\b|\bresearcher\b/);
  }, 120_000);

  it('the Admin persona’s delegation is unchanged: it reaches the researcher', async () => {
    h.script = { researcher: [{ text: 'researched' }] };
    const row = {
      slug: 'invoke_agent',
      name: 'invoke_agent',
      description: 'invoke_agent',
      handler: { kind: 'builtin', ref: 'invoke_agent' },
      inputSchema: { type: 'object', properties: {} },
      requiresConfirm: false,
      externalAccess: null,
    } as unknown as Tool;
    const res = await m.withTurnScope(
      { kind: 'assistant', loginId: owner, ws: [ws.admin], modWs: [ws.admin] },
      () =>
        tools.dispatchTool(
          row,
          { agent_slug: 'researcher', prompt: 'look it up' },
          {
            caller: tools.turnCaller(),
            ownerId: owner,
            surface: { kind: 'web', loginId: owner },
            agent: { slug: 'assistant', depth: 1, delegateTo: ['researcher', 'toolsmith'] },
          },
        ),
      { writes: true },
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(h.calls.researcher).toBe(1);
    const trace = await childTrace('researcher');
    expect(trace?.data.workspace_delegation).toBeUndefined();
    expect(m.takeActorMisses()).toEqual([]);
  }, 120_000);
});
