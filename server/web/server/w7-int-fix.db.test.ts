/**
 * The W7 integration fix, on a migrated scratch database: the anchor, and a
 * second Admin login L (a user of Admin, no Moderator there) whose limits
 * switch the keys area off unless a test turns it on.
 *
 * Vault pairing (one rule, @mantle/tools secret-ref-gate.ts: a vault key
 * meets a host only by the anchor or a keys-area login, the configurer
 * recorded and answering at run time):
 *  A1. The Studio reset and the config adopt write a manifest route: the
 *      provider's own host, configured_by null.
 *  A2. The sanity probe of a saved embedding route names its configurer.
 *  A3. Turning a mail account's TLS off with a blank password is a move.
 *  A4. A provider change on a keyed route with a base URL is a new pairing.
 *  A5. Provisioning an Azure route is the keys area's, and stamps it.
 * Chat isolation (each user reads only their own chats and digests):
 *  C1. A heartbeat on a helper or the Admin assistant answers its maker;
 *      its replies go to the maker and the anchor only.
 *  C3. The learned lanes ride only the anchor's own thread.
 *  C4. A brain not on workspaces: a helper answering a login runs.
 *  C5. Persona notes are the anchor login's only.
 *  C7. A helper started from a scope's system-pool work answers that
 *      scope's login, and refuses a scope with none.
 * (C2 and C6 are unit tests: telegram-turn.test.ts, runs-resume-turn.test.ts.)
 *
 * Only the model, its key, the vault seal and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7-int-fix.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  session: null as unknown,
  scope: null as unknown,
  stamp: null as unknown,
  digests: [] as string[],
  ownerId: '',
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.session),
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-fake'),
}));
// Every vault value opens to one string, so a leak is easy to see.
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => 'w7-int-vault-plaintext'),
}));
// The model: records the scope its turn runs in and the digests it can read.
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async () => {
    const db = await import('@mantle/db');
    const viewer = await import('@mantle/db/viewer');
    h.scope = db.currentScope();
    h.stamp = viewer.currentTurnStamp();
    const rows = await db.db
      .select({ data: db.nodes.data })
      .from(db.nodes)
      .where(
        sql`${db.nodes.ownerId} = ${h.ownerId}
            and ${db.nodes.tags} @> array['conversation-digest']::text[]`,
      );
    h.digests = rows.map((r) => String((r.data as { login_id?: string }).login_id));
    return { text: 'fired, done', model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('W7 integration fix', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let hbs: typeof import('@mantle/runtime/heartbeats');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const second = randomUUID(); // L: a user of Admin
  const tag = `w7int${randomUUID().slice(0, 6)}`;
  const apiKeyId = randomUUID();
  let adminWs = '';
  let agent: import('@mantle/db').Agent; // the Admin assistant
  let remy: import('@mantle/db').Agent; // a helper (no workspace)
  const outbound: string[] = [];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn);
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
    x(sql`update workspace_users
             set limits = ${JSON.stringify(on ? {} : { areas: { keys: false } })}::jsonb
           where workspace_id = ${adminWs} and login_id = ${second}`);
  const leaked = () => outbound.filter((o) => o.includes('w7-int-vault-plaintext'));
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
        memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
        ...extra,
      })
      .returning();
    return row!;
  };
  const newHeartbeat = async (slug: string, agentSlug: string, maker: string | null) => {
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                   schedule_kind, schedule, surface)
      values (${owner}, ${slug}, 'Check', ${agentSlug}, ${`${tag}-check`},
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb)`);
    await x(sql`update heartbeats set created_by = ${maker} where slug = ${slug}`);
    const [row] = await m.systemDb
      .select()
      .from(m.heartbeats)
      .where(sql`${m.heartbeats.slug} = ${slug}`);
    return row!;
  };
  const newDigest = async (login: string) => {
    const id = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path, audience, tags, data, login_id)
      values (${id}, ${owner}, 'note', 'Digest', 'notes', 'admin',
              array['conversation-digest']::text[],
              ${JSON.stringify({ kind: 'conversation_digest', login_id: login, summary: tag })}::jsonb,
              ${login})`);
    await x(sql`insert into item_grants (node_id, workspace_id, write, is_home)
      values (${id}, ${adminWs}, false, true) on conflict do nothing`);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7-int-fix-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_ADMIN_READS;
    h.ownerId = owner;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string; headers?: unknown }) => {
        const req = input instanceof Request ? input : null;
        const url = String(req ? req.url : input);
        const hdrs = new Headers((req?.headers ?? init?.headers ?? {}) as HeadersInit);
        outbound.push(
          `${req?.method ?? init?.method ?? 'GET'} ${url} ${hdrs.get('authorization') ?? ''} ${hdrs.get('api-key') ?? ''}`,
        );
        if (url.endsWith('/models')) return Response.json({ data: [] });
        if (url.includes('/embeddings')) {
          return Response.json({ data: [{ embedding: Array(768).fill(0.01), index: 0 }] });
        }
        if (url.startsWith('https://')) return Response.json({ ok: true });
        return new Response('{"error":"offline in the W7 test"}', { status: 503 });
      }),
    );
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    hbs = await import('@mantle/runtime/heartbeats');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${second}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Second Admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${adminWs}, ${second}, false)
                on conflict (workspace_id, login_id) do update set moderator = false`);
    const keys = await import('@mantle/api-keys');
    await sys(() => keys.setApiKey(owner, 'openai', 'default', 'sk-real-secret'));
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`);
    agent = await newAgent(`${tag}-admin`);
    remy = await newAgent(`${tag}-remy`, { workspaceId: null });
    await x(sql`insert into skills (owner_id, slug, name, description)
      values (${owner}, ${`${tag}-check`}, 'Check', 'Check in.')`);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.session = null;
    h.scope = null;
    h.stamp = null;
    h.digests = [];
    outbound.length = 0;
    await setKeys(false);
  });

  // ── A. vault pairing ───────────────────────────────────────────────────

  it('A1: a Studio reset puts a manifest route on the provider host, configured by none', async () => {
    const { MANIFEST_AGENTS } = await import('@/lib/system-manifest');
    const slug = MANIFEST_AGENTS.find((a) => !a.isPersona && a.systemPrompt)!.slug;
    await newAgent(slug, {
      workspaceId: null,
      provider: 'openai',
      baseUrl: 'https://192.0.2.10/v1',
      viaTailnet: true,
      backupBaseUrl: 'https://192.0.2.11/v1',
      configuredBy: second,
    });
    as(owner);
    const reset = await import('@/app/api/studio/reset/route');
    const res = await reset.POST(json({ slug }));
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await x<Record<string, unknown>>(sql`select provider, base_url, via_tailnet,
        backup_base_url, configured_by from agents where owner_id = ${owner} and slug = ${slug}`);
    expect(row).toEqual({
      provider: 'openrouter',
      base_url: null,
      via_tailnet: false,
      backup_base_url: null,
      configured_by: null,
    });
  });

  it('A1: a config adopt of a worker does the same', async () => {
    await x(sql`insert into ai_workers (owner_id, kind, slug, name, provider, model, base_url,
                                   via_tailnet, configured_by, is_default)
      values (${owner}, 'summarizer', 'summarizer', 'Summarizer', 'openai', 'x/y', 'https://192.0.2.12/v1',
              true, ${second}, true)`);
    as(owner);
    const adopt = await import('@/app/api/config/adopt/route');
    const res = await adopt.POST(json({ kind: 'worker', slug: 'summarizer' }));
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await x<Record<string, unknown>>(sql`select base_url, via_tailnet,
        configured_by from ai_workers where owner_id = ${owner} and kind = 'summarizer'`);
    expect(row).toEqual({ base_url: null, via_tailnet: false, configured_by: null });
  });

  it('A2: the sanity probe of a saved embedding route answers to its configurer', async () => {
    await x(sql`insert into embedding_config (owner_id, model, primary_provider,
                                         primary_base_url, configured_by)
      values (${owner}, 'text-embedding-3-small', 'openai', 'https://192.0.2.20/v1', ${second})
      on conflict (owner_id) do update set primary_base_url = excluded.primary_base_url,
        configured_by = excluded.configured_by, primary_provider = excluded.primary_provider`);
    (await import('@mantle/embeddings')).clearEmbeddingModelCache();
    const steps = await import('@/lib/onboarding-steps');
    const checks = await steps.runSanityChecks(owner);
    const embed = checks.find((k) => k.label.startsWith('Embeddings'));
    expect(embed?.ok).toBe(false);
    expect(leaked()).toEqual([]);
    expect(outbound.some((o) => o.includes('192.0.2.20'))).toBe(false);
    await x(sql`delete from embedding_config where owner_id = ${owner}`);
    (await import('@mantle/embeddings')).clearEmbeddingModelCache();
  });

  it('A3: turning TLS off with a blank password is a move', async () => {
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
    for (const off of [{ secure: false }, { smtpSecure: false }]) {
      const res = await edit(off);
      expect(res.status, JSON.stringify(off)).toBe(403);
      expect(await res.text()).toMatch(/TLS off/);
    }
    // TLS on, the stored host and port: the gate lets it by.
    expect((await edit({})).status).not.toBe(403);
    await setKeys(true);
    expect((await edit({ secure: false })).status).not.toBe(403);
  });

  it('A4: a provider change on a keyed route with a base URL is a new pairing', async () => {
    const pair = await import('@/lib/model-route-pair');
    const before = { provider: 'openrouter', apiKeyId, baseUrl: 'https://192.0.2.13/v1' };
    expect(pair.modelRoutesRepaired(before, { provider: 'openai' }, pair.AGENT_ROUTES)).toBe(true);
    expect(pair.modelRoutesRepaired(before, { model: 'other' }, pair.AGENT_ROUTES)).toBe(false);
    const keyed = await newAgent(`${tag}-keyed`, { baseUrl: 'https://192.0.2.13/v1' });
    as(second);
    const one = await import('@/app/api/agents/[id]/route');
    const res = await one.PATCH(json({ provider: 'openai' }, 'PATCH'), params('id', keyed.id));
    expect(res.status).toBe(403);
    expect(
      (await x<{ p: string }>(sql`select provider as p from agents where id = ${keyed.id}`))[0]!.p,
    ).toBe('openrouter');
  });

  it('A5: provisioning an Azure route is the keys area’s, and records who did it', async () => {
    const choices = await import('@mantle/client-types/model-choices');
    const assistantModel = choices.ASSISTANT_MODEL_CHOICES.find((x2) => x2.azure)!.id;
    const workerModel = choices.WORKER_MODEL_CHOICES.find((x2) => x2.azure)!.id;
    const onboarding = await import('@/app/api/onboarding/route');
    as(owner);
    const saved = await onboarding.POST(
      json({
        action: 'models',
        route: 'azure',
        assistantModel,
        workerModel,
        azureBaseUrl: 'https://192.0.2.30/openai/v1',
        azureKey: 'azure-test-key',
      }),
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(((await saved.json()) as { ok: boolean }).ok).toBe(true);
    as(second);
    const refused = await onboarding.POST(json({ action: 'provision' }));
    expect(refused.status).toBe(403);
    await setKeys(true);
    const done = await onboarding.POST(json({ action: 'provision' }));
    expect(done.status, await done.clone().text()).toBe(200);
    const rows = await x<{ c: string | null }>(sql`select configured_by::text as c
      from ai_workers where owner_id = ${owner} and provider = 'custom'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.c === second)).toBe(true);
  });

  // ── C. chat isolation ──────────────────────────────────────────────────

  it("C1: L's heartbeat on a helper answers L and reads no digest of the anchor", async () => {
    await newDigest(owner);
    await newDigest(second);
    const row = await newHeartbeat(`${tag}-hb-remy-l`, remy.slug, second);
    const fired = await hbs.tickFire(row);
    expect(fired.disposition, fired.error).toBe('fired');
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: second, ws: [adminWs] });
    expect(h.stamp).toMatchObject({ loginId: second });
    expect(h.digests).not.toContain(owner);
  });

  it("C1: the anchor's heartbeat on a helper answers the anchor and reads no digest of L", async () => {
    const row = await newHeartbeat(`${tag}-hb-remy-o`, remy.slug, null);
    const fired = await hbs.tickFire(row);
    expect(fired.disposition, fired.error).toBe('fired');
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: owner, ws: [adminWs] });
    expect(h.digests).not.toContain(second);
  });

  it('C1: a fire’s reply goes to the heartbeat’s maker and the anchor only', async () => {
    const mine = await newHeartbeat(`${tag}-hb-reply-o`, agent.slug, null);
    const theirs = await newHeartbeat(`${tag}-hb-reply-l`, agent.slug, second);
    for (const hb of [mine, theirs]) {
      await x(sql`insert into heartbeat_fires (heartbeat_id, disposition, reply_text)
        values (${hb.id}, 'fired', ${`${tag} reply ${hb.slug}`})`);
    }
    const detail = await import('@/app/api/heartbeats/[id]/detail/route');
    const reply = async (hbId: string) => {
      const res = await detail.GET(new Request('http://x/'), params('id', hbId));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { fires: { replyText: string | null }[] };
      return body.fires[0]!.replyText;
    };
    as(second);
    expect(await reply(mine.id)).toBeNull();
    expect(await reply(theirs.id)).toMatch(tag);
    as(owner);
    expect(await reply(mine.id)).toMatch(tag);
    expect(await reply(theirs.id)).toMatch(tag);
  });

  it("C3: the learned lanes ride only the anchor's own thread", async () => {
    await sys(() => c.createJournal(owner, { kind: 'preference', body: `${tag} likes the sea` }));
    await sys(() =>
      c.createJournal(owner, {
        kind: 'lesson',
        author: 'agent',
        agentSlug: agent.slug,
        body: `${tag} learned a lesson`,
      }),
    );
    const assistant = await import('@mantle/runtime/assistant');
    const prefs = await sys(() => c.loadProfilePreferences(owner));
    // The cached prefix and, with the tiers live, the tier 1 block.
    const prompt = async (login: string) => {
      const turn = await assistant.assembleResponderTurn({
        ownerId: owner,
        agent,
        ownerLoginId: login,
        prefs,
        logPrefix: '[w7-int]',
      });
      return `${turn.effectiveSystemPrompt}\n${turn.journalBlock}`;
    };
    const anchor = await prompt(owner);
    expect(anchor).toContain(`${tag} likes the sea`);
    const other = await prompt(second);
    expect(other).not.toContain(`${tag} likes the sea`);
    expect(other).not.toContain(`${tag} learned a lesson`);
  });

  it('C4: on a brain not on workspaces a helper answering a login runs', async () => {
    const owner2 = randomUUID();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role)
      values (${owner2}, ${`${tag}-o2@example.invalid`}, 'x', false, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner2}, 'brain', ${owner2})
      on conflict (id) do nothing`);
    const [main] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner2,
        slug: `${tag}-main2`,
        name: 'Main',
        model: 'fake/model',
        provider: 'openrouter',
        systemPrompt: 'p',
        workspaceId: null,
        toolGroupSlugs: [],
      })
      .returning();
    const voice = await import('@mantle/voice');
    const result = await rt.runToolLoop({
      adapter: voice.getChatAdapter('openrouter')!,
      apiKey: 'sk-fake',
      model: 'fake/model',
      params: {},
      ownerId: owner2,
      agentId: main!.id,
      agentSlug: main!.slug,
      agentLevel: 'admin',
      initialMessages: [{ role: 'user', content: 'hello' }],
      tools: [],
      surface: { kind: 'web', loginId: owner2 },
    });
    expect(result.reply).toBe('fired, done');
  });

  it('C5: persona notes are the anchor login’s only', async () => {
    await x(
      sql`update agents set persona_notes = ${JSON.stringify([
        {
          ref: 'n1',
          kind: 'style',
          content: `${tag} note`,
          createdAt: new Date().toISOString(),
        },
      ])}::jsonb where id = ${agent.id}`,
    );
    const list = await import('@/app/api/agents/route');
    const notesOf = async () => {
      const res = await list.GET();
      const body = (await res.json()) as {
        agents: { id: string; personaNotes: unknown[] }[];
      };
      return body.agents.find((a) => a.id === agent.id)!.personaNotes;
    };
    as(owner);
    expect(await notesOf()).toHaveLength(1);
    as(second);
    expect(await notesOf()).toEqual([]);
    const debug = await import('@/app/api/debug/agents/route');
    const dbg = (await (await debug.GET()).json()) as { personaNotes: unknown[] };
    expect(JSON.stringify(dbg.personaNotes)).not.toContain(tag);
    const persona = await import('@/app/api/agents/[id]/persona/route');
    const curated = await persona.POST(
      json({ action: 'add', kind: 'style', content: 'Short answers.' }),
      { params: Promise.resolve({ id: agent.id }) },
    );
    expect(curated.status).toBe(403);
    const refused = await rt.withAgentScope(
      { id: agent.id, ownerId: owner, audience: 'admin', workspaceId: adminWs },
      () =>
        t.dispatchTool(
          {
            slug: 'update_persona',
            handler: { kind: 'builtin', ref: 'update_persona' },
            inputSchema: {},
          } as unknown as import('@mantle/db').Tool,
          { add: { kind: 'style', content: `${tag} learned from L` } },
          {
            ownerId: owner,
            surface: { kind: 'web', loginId: second },
            agent: { slug: agent.slug, depth: 1, delegateTo: [] },
          },
        ),
      { ownerLoginId: second },
    );
    expect(refused.ok).toBe(false);
    const stored = await x<{ n: string }>(
      sql`select persona_notes::text as n from agents where id = ${agent.id}`,
    );
    expect(stored[0]!.n).not.toContain('learned from L');
  });

  it("C7: a helper started from a scope's system-pool work answers that scope's login", async () => {
    const helper = { id: remy.id, ownerId: owner, audience: 'admin', workspaceId: null };
    const seen = await m.withTurnScope(
      { kind: 'assistant', loginId: second, ws: [adminWs], modWs: [] },
      () => m.asSystem(() => rt.withAgentScope(helper, async () => m.currentScope()), 'admin-area'),
      { writes: true },
    );
    expect(seen).toMatchObject({ kind: 'assistant', loginId: second, ws: [adminWs] });
    await expect(
      m.withTurnScope({ kind: 'assistant', loginId: null, ws: [adminWs], modWs: [] }, () =>
        m.asSystem(() => rt.withAgentScope(helper, async () => 1), 'admin-area'),
      ),
    ).rejects.toThrow(/needs the login that called it/);
    await expect(
      m.withTurnScope({ kind: 'assistant', loginId: second, ws: [adminWs], modWs: [] }, () =>
        m.asSystem(
          () => rt.withAgentScope(helper, async () => 1, { ownerLoginId: owner }),
          'admin-area',
        ),
      ),
    ).rejects.toThrow(/not another login/);
  });
});
