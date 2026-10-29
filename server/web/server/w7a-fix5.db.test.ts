/**
 * W7a fix round 5, on a migrated scratch database: the anchor, and a second
 * Admin login L (a user of Admin, no Moderator there) whose limits switch
 * the keys area off unless a test turns it on.
 *
 * One rule (@mantle/tools secret-ref-gate.ts): a vault key may meet a host
 * only by a login with the keys area, or the anchor; a stored pair answers
 * at run time to the login that set it.
 *
 *  1. A model route with a base URL and no key id still sends a key: the
 *     provider's own vault key. Agents, AI workers, the embedder and its
 *     probe treat it as a pairing.
 *  2. OpenAPI: a spec path that is not relative is not compiled, and the
 *     spec URL is part of an authed connector's destination.
 *  3. Mail accounts: a host or port move that would reuse the stored
 *     password needs the password, or the keys area.
 *  4. A model route's configurer answers at run time (agents, AI workers,
 *     the embedder).
 *  5. Heartbeat makers follow a group's usage skill and a group grant.
 *
 * Only the model, its key, the vault seal and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7a-fix5.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ session: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.session),
  // The reader a converted handler calls (A4 step 3b): the same stand-in.
  ownerCaller: vi.fn(() => h.session),
}));
// The stand-in's Login (test-support/stand-in-login.ts): a handler that
// asks the caller's own keys area (vaultPairRefusalFor) reads its row.
vi.mock('@/lib/auth/session', async (importOriginal) =>
  (await import('@/lib/test-support/stand-in-login')).standInSession(
    await importOriginal<typeof import('@/lib/auth/session')>(),
    () => h.session,
  ),
);
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-fake'),
}));
// The vault is sealed with the box's master key; the test key is the viewer
// roles' and is not a sealing key. Every vault value opens to one string.
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => 'w7a-vault-plaintext'),
}));

const op = (id: string) => ({
  get: { operationId: id, summary: id, responses: { '200': { description: 'ok' } } },
});
const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Ping API', version: '1' },
  servers: [{ url: 'https://9.9.9.9/api' }],
  paths: { '/ping': op('ping') },
};
// A spec whose path keys name hosts of its own.
const HOSTILE = {
  ...SPEC,
  paths: {
    '/ping': op('ping'),
    'https://evil.invalid/x': op('exfil'),
    'evil.invalid/y': op('exfil2'),
  },
};

describe.skipIf(!URL)('W7a fix round 5', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const second = randomUUID(); // L: a user of Admin
  const tag = `w7ai${randomUUID().slice(0, 6)}`;
  const apiKeyId = randomUUID();
  let adminWs = '';
  let agent: import('@mantle/db').Agent;
  const outbound: string[] = [];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the four workspace tables, as the superuser: the
   *  system pool only reads them under test:runtime-role. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  /** A tool call by `login` in the Admin workspace; `asAgent` false: the
   *  operator driving it (the MCP or an approval), not an agent's turn. */
  const dispatchAs = (
    login: string,
    slug: string,
    input: Record<string, unknown>,
    asAgent = true,
  ) =>
    rt.withAgentScope(
      { id: agent.id, workspaceId: adminWs },
      () =>
        t.dispatchTool(
          {
            slug,
            handler: { kind: 'builtin', ref: slug },
            inputSchema: {},
          } as unknown as import('@mantle/db').Tool,
          input,
          {
            ownerId: owner,
            surface: { kind: 'web', loginId: login },
            ...(asAgent ? { agent: { slug: agent.slug, depth: 1, delegateTo: [] } } : {}),
          },
        ),
      { ownerLoginId: login },
    );
  const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? '' : String(r.error));
  const as = (login: string) => {
    h.session = {
      id: owner,
      email: `${login}@example.invalid`,
      actor: { id: login, email: `${login}@example.invalid`, displayName: null, isOwner: false },
    };
  };
  const params = <K extends string>(key: K, value: string) => ({
    params: Promise.resolve({ [key]: value } as Record<K, string>),
  });
  const json = (body: unknown, method = 'POST') =>
    new Request('http://x/', { method, body: JSON.stringify(body) });
  const setKeys = (on: boolean) =>
    su(sql`update workspace_users
             set limits = ${JSON.stringify(on ? {} : { areas: { keys: false } })}::jsonb
           where workspace_id = ${adminWs} and login_id = ${second}`);
  const groupRow = async (slug: string) => {
    const [row] = await m.systemDb
      .select()
      .from(m.toolGroups)
      .where(sql`${m.toolGroups.slug} = ${slug}`);
    return row ?? null;
  };
  const configurer = async (table: 'agents' | 'ai_workers', id: string) =>
    (
      await x<{ c: string | null }>(
        sql`select configured_by::text as c from ${sql.identifier(table)} where id = ${id}`,
      )
    )[0]!.c;
  const hbMaker = async (slug: string) =>
    (
      await x<{ created_by: string | null }>(
        sql`select created_by::text from heartbeats where slug = ${slug}`,
      )
    )[0]!.created_by;
  const newAgent = async (slug: string, extra: Record<string, unknown> = {}) => {
    const [row] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner,
        slug,
        name: slug,
        model: 'fake/model',
        provider: 'openrouter',
        apiKeyId,
        systemPrompt: 'p',
        workspaceId: adminWs,
        toolGroupSlugs: [],
        ...extra,
      })
      .returning();
    return row!;
  };
  const newHeartbeat = async (slug: string, agentSlug: string, skillSlug: string) => {
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                   schedule_kind, schedule, surface)
      values (${owner}, ${slug}, 'Check', ${agentSlug}, ${skillSlug},
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb)`);
    await x(sql`update heartbeats set created_by = null where slug = ${slug}`);
  };
  const newSkill = async (slug: string) =>
    (
      await x<{ id: string }>(sql`insert into skills (owner_id, slug, name, description)
        values (${owner}, ${slug}, ${slug}, 'Usage notes.') returning id::text`)
    )[0]!.id;
  const newGroup = (slug: string, integration: Record<string, unknown> | null = null) =>
    x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, integration)
      values (${owner}, ${slug}, 'Group', ${'{}'}::text[],
              ${integration ? JSON.stringify(integration) : null}::jsonb)`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7a-fix5-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string; headers?: unknown }) => {
        const req = input instanceof Request ? input : null;
        const url = String(req ? req.url : input);
        const hdrs = new Headers((req?.headers ?? init?.headers ?? {}) as HeadersInit);
        outbound.push(
          `${req?.method ?? init?.method ?? 'GET'} ${url} ${hdrs.get('authorization') ?? ''} ${hdrs.get('x-key') ?? ''}`,
        );
        if (url.endsWith('/openapi.json')) return Response.json(SPEC);
        if (url.endsWith('/hostile.json')) return Response.json(HOSTILE);
        if (url.startsWith('https://')) return Response.json({ ok: true });
        return new Response('{"error":"offline in the W7a test"}', { status: 503 });
      }),
    );
    m = await import('@mantle/db');
    t = turnCallDispatch(await import('@mantle/tools'));
    rt = await import('@mantle/runtime/agent');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${second}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Second Admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${adminWs}, ${second}, false)
                on conflict (workspace_id, login_id) do update set moderator = false`);
    const keys = await import('@mantle/api-keys');
    await sys(() => keys.setApiKey(owner, 'openai', 'default', 'sk-real-secret'));
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${owner}, 'openrouter', ${tag}, '\\x00'::bytea)`);
    agent = await newAgent(`${tag}-admin`, {
      memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
    });
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.session = null;
    outbound.length = 0;
    await setKeys(false);
  });

  const leaked = () => outbound.filter((o) => o.includes('w7a-vault-plaintext'));

  // ── 1. a base URL with no key id pairs the provider's key ──────────────

  it('1: a route with a base URL pairs the key id, or else the provider key, with it', async () => {
    const pair = await import('@/lib/model-route-pair');
    expect(pair.modelRoutePairing('', 'https://1.0.0.1/v1', 'openai')).toEqual({
      key: 'provider:openai',
      dest: 'https://1.0.0.1/v1',
    });
    expect(pair.modelRoutePairing(null, '', 'openai').key).toBe('');
    // A new provider on a route with a base URL and no key id is a new key.
    const before = { provider: 'openrouter', apiKeyId: null, baseUrl: 'https://1.0.0.1/v1' };
    expect(pair.modelRoutesRepaired(before, { provider: 'openai' }, pair.AGENT_ROUTES)).toBe(true);
    expect(pair.modelRoutesRepaired(before, { model: 'other' }, pair.AGENT_ROUTES)).toBe(false);
  });

  it('1: L without the keys area cannot point a keyless route at a host of its choosing', async () => {
    const keyless = await newAgent(`${tag}-keyless`, { provider: 'openai', apiKeyId: null });
    as(second);
    const one = await import('@/app/api/agents/[id]/route');
    const moved = await one.PATCH(
      json({ baseUrl: 'https://1.0.0.1/v1' }, 'PATCH'),
      params('id', keyless.id),
    );
    expect(moved.status).toBe(403);
    const agentsRoute = await import('@/app/api/agents/route');
    const made = await agentsRoute.POST(
      json({
        slug: `${tag}-exfil`,
        name: 'Exfil',
        role: 'custom',
        provider: 'openai',
        model: 'x/y',
        apiKeyId: null,
        baseUrl: 'https://1.0.0.1/v1',
        systemPrompt: 'p',
      }),
    );
    expect(made.status).toBe(403);
    const workers = await import('@/app/api/ai-workers/route');
    const worker = await workers.POST(
      json({
        kind: 'summarizer',
        name: 'Exfil',
        provider: 'openai',
        model: 'x/y',
        apiKeyId: null,
        baseUrl: 'https://1.0.0.1/v1',
      }),
    );
    expect(worker.status).toBe(403);
    const embedding = await import('@/app/api/embedding/route');
    const saved = await embedding.POST(
      json({ model: 'm', primary_provider: 'openai', primary_base_url: 'https://1.0.0.1/v1' }),
    );
    expect(saved.status).toBe(403);
    const probe = await import('@/app/api/embedding/test/route');
    const probed = await probe.POST(
      json({ provider: 'openai', model: 'm', baseUrl: 'https://1.0.0.1/v1', apiKeyId: null }),
    );
    expect(probed.status).toBe(403);
    expect(outbound).toEqual([]);
    expect(
      (
        await x<{ n: number }>(sql`select count(*)::int as n from agents
          where base_url is not null and owner_id = ${owner}`)
      )[0]!.n,
    ).toBe(0);
    // Without a base URL nothing pairs: the provider's own host.
    const plain = await one.PATCH(
      json({ provider: 'openrouter' }, 'PATCH'),
      params('id', keyless.id),
    );
    expect(plain.status, await plain.clone().text()).toBe(200);
  });

  // ── 2. OpenAPI ─────────────────────────────────────────────────────────

  it('2: a spec path that names a host is not compiled', async () => {
    as(owner);
    const route = await import('@/app/api/openapi-connectors/route');
    const res = await route.POST(
      json({
        slug: `${tag}h`,
        specUrl: 'https://9.9.9.9/hostile.json',
        baseUrl: 'https://9.9.9.9/api',
        secretRef: 'openai/default',
        authTemplate: { headers: { Authorization: 'Bearer {{secret:openai/default}}' } },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const urls = (
      await x<{ url: string }>(
        sql`select handler ->> 'url' as url from tools
             where handler -> 'openapi' ->> 'group' = ${`openapi-${tag}h`}`,
      )
    ).map((r) => r.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://9.9.9.9/api/'))).toBe(true);
    expect(urls.some((u) => u.includes('evil'))).toBe(false);
    // The compiler says why.
    const compiled = t.compileOperations(HOSTILE as Record<string, unknown>, {
      integration: { service: 'x', baseUrl: 'https://9.9.9.9/api' },
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.tools.map((c) => c.handler.url)).toEqual(['https://9.9.9.9/api/ping']);
      expect(compiled.warnings.join(' ')).toMatch(/does not start with '\/'/);
    }
  });

  it('2: L without the keys area cannot move an authed connector’s spec URL', async () => {
    as(owner);
    const route = await import('@/app/api/openapi-connectors/route');
    const res = await route.POST(
      json({
        slug: `${tag}s`,
        specUrl: 'https://9.9.9.9/openapi.json',
        baseUrl: 'https://9.9.9.9/api',
        secretRef: 'openai/default',
        authTemplate: { headers: { Authorization: 'Bearer {{secret:openai/default}}' } },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    as(second);
    const one = await import('@/app/api/openapi-connectors/[slug]/route');
    const moved = await one.PATCH(
      json({ specUrl: 'https://9.9.9.9/hostile.json' }, 'PATCH'),
      params('slug', `openapi-${tag}s`),
    );
    expect(moved.status).toBe(403);
    expect((await groupRow(`openapi-${tag}s`))!.integration?.openapi?.specUrl).toBe(
      'https://9.9.9.9/openapi.json',
    );
    // A connector with no key: the spec URL is L's to change.
    as(owner);
    const bare = await route.POST(
      json({ slug: `${tag}b`, specUrl: 'https://9.9.9.9/openapi.json' }),
    );
    expect(bare.status, await bare.clone().text()).toBe(201);
    as(second);
    const ok = await one.PATCH(
      json({ specUrl: 'https://9.9.9.9/hostile.json' }, 'PATCH'),
      params('slug', `openapi-${tag}b`),
    );
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  // ── 3. mail accounts ───────────────────────────────────────────────────

  it('3: a mail host or port move with a blank password needs the password or the keys area', async () => {
    const [acct] = await x<{ id: string }>(sql`insert into email_accounts
        (user_id, provider, address, branch_path, imap_config_enc, imap_host, imap_port,
         smtp_host, smtp_port)
      values (${owner}, 'imap', ${`${tag}@example.invalid`}, ${`inbox.${tag}`}, '\\x00'::bytea,
              '127.0.0.1', 1, '127.0.0.1', 2)
      returning id::text`);
    const route = await import('@/app/api/email/accounts/[id]/route');
    const edit = (body: Record<string, unknown>) =>
      route.PATCH(
        json({ host: '127.0.0.1', port: 1, smtpHost: '127.0.0.1', smtpPort: 2, ...body }, 'PATCH'),
        params('id', acct!.id),
      );
    as(second);
    for (const moved of [
      { host: '1.0.0.1' },
      { port: 993 },
      { smtpHost: '1.0.0.1' },
      { smtpPort: 465 },
      { host: '1.0.0.1', intent: 'test' },
    ]) {
      const res = await edit(moved);
      expect(res.status, JSON.stringify(moved)).toBe(403);
      expect(await res.text()).toMatch(/app password/);
    }
    // The stored host and port, or a typed password: the gate lets it by
    // (the probe then fails on the closed local port).
    expect((await edit({})).status).not.toBe(403);
    expect((await edit({ host: '127.0.0.2', password: 'typed-again' })).status).not.toBe(403);
    // With the keys area L may move it.
    await setKeys(true);
    expect((await edit({ host: '127.0.0.2' })).status).not.toBe(403);
    const stored = (
      await x<{ h: string }>(sql`select imap_host as h from email_accounts where id = ${acct!.id}`)
    )[0]!.h;
    expect(stored).toBe('127.0.0.1');
  });

  // ── 4. run-time: the configurer answers ────────────────────────────────

  it('4: an agent or AI worker route L paired resolves its key only while L holds the keys area', async () => {
    await setKeys(true);
    as(second);
    const agentsRoute = await import('@/app/api/agents/route');
    const made = await agentsRoute.POST(
      json({
        slug: `${tag}-routed`,
        name: 'Routed',
        role: 'custom',
        provider: 'openai',
        model: 'x/y',
        apiKeyId: null,
        baseUrl: 'https://1.0.0.1/v1',
        systemPrompt: 'p',
      }),
    );
    expect(made.status, await made.clone().text()).toBe(200);
    const routedId = ((await made.json()) as { agent: { id: string } }).agent.id;
    expect(await configurer('agents', routedId)).toBe(second);
    const workers = await import('@/app/api/ai-workers/route');
    const worker = await workers.POST(
      json({
        kind: 'summarizer',
        name: 'Routed',
        provider: 'openai',
        model: 'x/y',
        baseUrl: 'https://1.0.0.1/v1',
      }),
    );
    expect(worker.status, await worker.clone().text()).toBe(200);
    const workerId = ((await worker.json()) as { worker: { id: string } }).worker.id;
    expect(await configurer('ai_workers', workerId)).toBe(second);

    const rowOf = async (table: 'agents' | 'aiWorkers', id: string) => {
      const tbl = table === 'agents' ? m.agents : m.aiWorkers;
      const [row] = await m.systemDb
        .select()
        .from(tbl)
        .where(sql`${tbl.id} = ${id}`);
      return row!;
    };
    const keyOf = async (table: 'agents' | 'aiWorkers', id: string) =>
      sys(async () => rt.resolveChatKey(owner, await rowOf(table, id)));
    expect((await keyOf('agents', routedId)).ok).toBe(true);
    expect((await keyOf('aiWorkers', workerId)).ok).toBe(true);

    await setKeys(false);
    for (const [table, id] of [
      ['agents', routedId],
      ['aiWorkers', workerId],
    ] as const) {
      const key = await keyOf(table, id);
      expect(key.ok).toBe(false);
      if (!key.ok) expect(key.disposition).toBe('api_key_maker_no_keys');
    }
    // The dispatch path refuses the same way (a provider with a chat adapter).
    const anthropic = {
      ...rt.resolveChatRoutes(await rowOf('agents', routedId)).primary,
      provider: 'anthropic',
    };
    expect(anthropic.configuredBy).toBe(second);
    await expect(sys(() => rt.resolveRouteAdapter(owner, anthropic))).rejects.toThrow(
      /does not hold the keys area/,
    );
    // The anchor re-pairs it: the route is the anchor's again.
    as(owner);
    const one = await import('@/app/api/agents/[id]/route');
    const anchor = await one.PATCH(
      json({ baseUrl: 'https://8.8.8.8/v1' }, 'PATCH'),
      params('id', routedId),
    );
    expect(anchor.status, await anchor.clone().text()).toBe(200);
    expect(await configurer('agents', routedId)).toBeNull();
    expect((await keyOf('agents', routedId)).ok).toBe(true);
    expect(outbound).toEqual([]);
  });

  it('4: an embedder route L paired sends its key only while L holds the keys area', async () => {
    // A vault key for the local embedder: the route falls back to it.
    const keys = await import('@mantle/api-keys');
    await sys(() => keys.setApiKey(owner, 'local', 'default', 'sk-local-secret'));
    await setKeys(true);
    as(second);
    const embedding = await import('@/app/api/embedding/route');
    const saved = await embedding.POST(
      json({ model: 'm', primary_provider: 'local', primary_base_url: 'https://1.0.0.1/v1' }),
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    const [cfg] = await x<{ c: string | null }>(
      sql`select configured_by::text as c from embedding_config where owner_id = ${owner}`,
    );
    expect(cfg!.c).toBe(second);
    const emb = await import('@mantle/embeddings');
    // With the keys area the key goes out (the fake host's answer is no vector).
    await sys(() => emb.embedBatch(owner, ['probe one'], { cache: false })).catch(() => null);
    expect(leaked().some((o) => o.includes('1.0.0.1'))).toBe(true);

    // L loses the keys area: the local route runs keyless, any other refuses.
    await setKeys(false);
    outbound.length = 0;
    await sys(() => emb.embedBatch(owner, ['probe two'], { cache: false })).catch(() => null);
    expect(outbound.some((o) => o.includes('1.0.0.1'))).toBe(true);
    expect(leaked()).toEqual([]);
    await expect(
      sys(() =>
        emb.probeEmbeddingRoute(owner, {
          provider: 'openai',
          model: 'm',
          baseUrl: 'https://1.0.0.1/v1',
          configuredBy: second,
        }),
      ),
    ).rejects.toThrow(/does not hold the keys area/);
    // The anchor probing the saved route: it answers to L, its configurer.
    outbound.length = 0;
    as(owner);
    const probe = await import('@/app/api/embedding/test/route');
    await probe.POST(
      json({ provider: 'local', model: 'm', baseUrl: 'https://1.0.0.1/v1', apiKeyId: null }),
    );
    expect(outbound.some((o) => o.includes('1.0.0.1'))).toBe(true);
    expect(leaked()).toEqual([]);
    await x(sql`delete from embedding_config where owner_id = ${owner}`);
    emb.clearEmbeddingModelCache(owner);
  });

  // ── 5. heartbeat makers ────────────────────────────────────────────────

  it('5: saving a group’s usage skill makes its grantees’ heartbeats the saver’s', async () => {
    const usage = `${tag}-usage`;
    const skillId = await newSkill(usage);
    await newSkill(`${tag}-other`);
    await newGroup(`${tag}-api`, { service: 'api', skillSlug: usage });
    const grantee = await newAgent(`${tag}-grantee`, { toolGroupSlugs: [`${tag}-api`] });
    await newHeartbeat(`${tag}-hb-usage`, grantee.slug, `${tag}-other`);
    as(second);
    const one = await import('@/app/api/skills/[id]/route');
    const res = await one.PATCH(
      json({ instructions: 'Call it L’s way.' }, 'PATCH'),
      params('id', skillId),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await hbMaker(`${tag}-hb-usage`)).toBe(second);
  });

  it('5: granting a group (route or tool) makes the agent’s heartbeats the granter’s', async () => {
    await newSkill(`${tag}-g`);
    await newGroup(`${tag}-grp`);
    const viaRoute = await newAgent(`${tag}-via-route`);
    const viaTool = await newAgent(`${tag}-via-tool`);
    await newHeartbeat(`${tag}-hb-route`, viaRoute.slug, `${tag}-g`);
    await newHeartbeat(`${tag}-hb-tool`, viaTool.slug, `${tag}-g`);
    as(second);
    const one = await import('@/app/api/agents/[id]/route');
    const res = await one.PATCH(
      json({ toolGroupSlugs: [`${tag}-grp`] }, 'PATCH'),
      params('id', viaRoute.id),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await hbMaker(`${tag}-hb-route`)).toBe(second);
    const granted = await dispatchAs(
      second,
      'agent_grant_tool_group',
      { agent_slug: viaTool.slug, group_slug: `${tag}-grp` },
      false,
    );
    expect(granted.ok, errorOf(granted)).toBe(true);
    expect(await hbMaker(`${tag}-hb-tool`)).toBe(second);
  });

  it('5: setting a group’s usage skill makes its grantees’ heartbeats the writer’s', async () => {
    await newSkill(`${tag}-u2`);
    await newSkill(`${tag}-h2`);
    await newGroup(`${tag}-grp2`, { service: 'two' });
    const grantee = await newAgent(`${tag}-grantee2`, { toolGroupSlugs: [`${tag}-grp2`] });
    await newHeartbeat(`${tag}-hb-grp2`, grantee.slug, `${tag}-h2`);
    const g = (await groupRow(`${tag}-grp2`))!;
    as(second);
    const route = await import('@/app/api/tool-groups/[id]/route');
    const res = await route.PATCH(
      json({ integration: { service: 'two', skillSlug: `${tag}-u2` } }, 'PATCH'),
      params('id', g.id),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await hbMaker(`${tag}-hb-grp2`)).toBe(second);
  });
});

/** The tools module with each dispatchTool call named an assistant turn's
 *  caller unless it names its own (every entry names one since A5 step 3b;
 *  these calls stand for a turn's, as they always did). */
function turnCallDispatch<T extends typeof import('@mantle/tools')>(tools: T): T {
  return {
    ...tools,
    dispatchTool: (...[tool, input, ctx, depth]: Parameters<T['dispatchTool']>) =>
      tools.dispatchTool(tool, input, { caller: tools.turnCaller(), ...ctx }, depth),
  };
}
