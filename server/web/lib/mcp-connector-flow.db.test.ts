/**
 * The whole connector flow, as ChatGPT runs it and as a Claude connector
 * runs it, on a real migrated Postgres through the real app (corporate
 * plan, phase 3). No live ChatGPT: each request is the one OpenAI's MCP
 * authentication guide describes.
 *
 *  1. discovery: the 401 from /api/mcp points at the protected resource
 *     metadata, whose `resource` is the MCP endpoint and whose
 *     authorization server is the issuer of the server metadata (exact
 *     string match), with PKCE S256 and a registration endpoint;
 *  2. dynamic registration with ChatGPT's callback redirect;
 *  3. sign-in: the consent page, Allow with the password, a code back to
 *     the redirect with the state;
 *  4. the code exchange and a refresh, each with `resource` for ChatGPT
 *     and with none for Claude, then an old host name: all get tokens;
 *  5. a read (note_list) and a write (note_create) over /api/mcp, and the
 *     refreshed token reads too;
 *  6. disconnect (Settings > MCP): the token gets the 401 challenge
 *     again and the refresh token is dead.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/mcp-connector-flow.db.test.ts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asSuperuser,
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  superuserClient,
} from '@mantle/db/test-support';

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
const PUBLIC = 'https://brain.example.invalid';
const PASSWORD = 'connector-flow-password';

type Json = Record<string, unknown>;

describe.skipIf(!URL_)('the MCP connector flow (ChatGPT and Claude)', () => {
  let m: typeof import('@mantle/db');
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let tokens: typeof import('./auth/tokens');
  let oauth: typeof import('./mcp-oauth');
  let app: import('hono').Hono;
  let wasOn = false;
  const tag = `ocflow-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const clients: string[] = [];
  let ip = 0;

  /** Each request from its own address: the per-address limits stay out. */
  const req = (path: string, init: RequestInit = {}) => {
    ip += 1;
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-for', `203.0.113.${ip % 250}`);
    return app.request(path, { ...init, headers });
  };
  const cookie = () => `mantle_session=${tokens.buildSessionCookie(admin).value}`;
  const setBoxSwitch = async (enabled: boolean) => {
    const res = await req('/api/mcp-settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookie() },
      body: JSON.stringify({ enabled }),
    });
    expect(res.status).toBe(200);
  };

  /** One JSON-RPC call to /api/mcp; the body, from JSON or an SSE frame. */
  let rpcId = 0;
  const mcp = async (bearer: string | null, method: string, params: Json = {}) => {
    rpcId += 1;
    const res = await req('/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
    });
    const text = await res.text();
    const data = text.startsWith('{')
      ? text
      : (text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .pop() ?? '{}');
    return { status: res.status, headers: res.headers, body: JSON.parse(data) as Json };
  };
  const callTool = async (bearer: string, name: string, args: Json) => {
    const r = await mcp(bearer, 'tools/call', { name, arguments: args });
    expect(r.status, name).toBe(200);
    const result = r.body.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError ?? false, `${name}: ${result.content?.[0]?.text}`).toBe(false);
    return result.content.map((c) => c.text).join('\n');
  };

  const token = (form: Record<string, string>) =>
    req('/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });

  /** Register, consent and exchange, as one client runs it. */
  const signIn = async (o: {
    clientName: string;
    redirect: string;
    resource: string | null;
  }) => {
    const reg = await req('/api/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: o.clientName,
        redirect_uris: [o.redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    clients.push(clientId);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(8).toString('hex');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: o.redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'mcp',
    });
    if (o.resource) q.set('resource', o.resource);
    const page = await req(`/api/oauth/authorize?${q}`, { headers: { cookie: cookie() } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(html)?.[1];
    expect(consentToken).toBeTruthy();

    const form = new URLSearchParams(q);
    form.delete('resource');
    form.delete('response_type');
    form.set('decision', 'allow');
    form.set('consent_token', consentToken!);
    form.set('password', PASSWORD);
    const allow = await req('/api/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
      body: form.toString(),
    });
    expect(allow.status).toBe(302);
    const back = new URL(allow.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(o.redirect);
    expect(back.searchParams.get('state')).toBe(state);
    const code = back.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const exchange = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: o.redirect,
      client_id: clientId,
      code_verifier: verifier,
      ...(o.resource ? { resource: o.resource } : {}),
    });
    expect(exchange.status).toBe(200);
    const t = (await exchange.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(t.token_type).toBe('Bearer');
    expect(t.expires_in).toBeGreaterThan(0);
    return { clientId, ...t };
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_PUBLIC_URL = PUBLIC;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'connector-flow-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./auth/tokens');
    oauth = await import('./mcp-oauth');
    await ensureTestAnchor(sql);
    const hash = await bcrypt.hash(PASSWORD, 4);
    await asSuperuser()`insert into auth.users (id, email, password_hash, role, display_name)
              values (${admin}, ${`${tag}-admin@example.com`}, ${hash}, 'admin', 'Ada Admin')`;
    const su = superuserClient(scratch.url);
    try {
      await su`select set_config('mantle.actor', 'system:test', false)`;
      await ensureAdminUsers(su, [admin]);
    } finally {
      await su.end();
    }
    const { createApp } = await import('../server/app');
    app = await createApp();
    wasOn = await oauth.isRemoteMcpEnabled();
    await setBoxSwitch(true);
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    if (app) await setBoxSwitch(wasOn);
    for (const c of clients) await sql`delete from oauth_clients where id = ${c}`;
  });

  it('discovery: the 401 challenge, the resource and the issuer line up', async () => {
    const challenge = await mcp(null, 'tools/list');
    expect(challenge.status).toBe(401);
    const www = challenge.headers.get('www-authenticate') ?? '';
    expect(www).toContain(
      `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`,
    );
    const prm = (await (await req('/.well-known/oauth-protected-resource')).json()) as Json;
    expect(prm.resource).toBe(`${PUBLIC}/api/mcp`);
    const as = (await (await req('/.well-known/oauth-authorization-server')).json()) as Json;
    expect(prm.authorization_servers).toEqual([as.issuer]);
    expect(as.code_challenge_methods_supported).toContain('S256');
    expect(as.registration_endpoint).toBe(`${PUBLIC}/api/oauth/register`);
    expect(as.grant_types_supported).toContain('refresh_token');
  });

  for (const flow of [
    {
      name: 'ChatGPT (resource sent)',
      clientName: 'ChatGPT',
      redirect: 'https://chatgpt.com/connector/oauth/test-callback-id',
      resource: `${PUBLIC}/api/mcp`,
    },
    {
      name: 'Claude (no resource)',
      clientName: 'Claude',
      redirect: 'https://claude.ai/api/mcp/auth_callback',
      resource: null,
    },
    {
      name: 'an old host name',
      clientName: 'Old host',
      redirect: 'https://client.example.invalid/cb',
      resource: 'https://old-name.example.invalid/api/mcp',
    },
  ]) {
    it(`${flow.name}: sign-in, read, write, refresh, disconnect`, async () => {
      const t = await signIn(flow);

      // A read and a write, with the first access token.
      const init = await mcp(t.access_token, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: flow.clientName, version: '1' },
      });
      expect(init.status).toBe(200);
      const list = await mcp(t.access_token, 'tools/list');
      expect(list.status).toBe(200);
      const names = ((list.body.result as { tools: { name: string }[] }).tools ?? []).map(
        (x) => x.name,
      );
      expect(names).toEqual(expect.arrayContaining(['note_list', 'note_create']));
      const title = `${tag} ${flow.clientName}`;
      await callTool(t.access_token, 'note_create', { title, content: 'made over MCP' });
      expect(await callTool(t.access_token, 'note_list', { query: title })).toContain(title);

      // A refresh (with the same resource, or none), and the new token reads.
      const r = await token({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: t.clientId,
        ...(flow.resource ? { resource: flow.resource } : {}),
      });
      expect(r.status).toBe(200);
      const fresh = (await r.json()) as { access_token: string; refresh_token: string };
      expect(fresh.access_token).not.toBe(t.access_token);
      expect(await callTool(fresh.access_token, 'note_list', { query: title })).toContain(title);

      // Disconnect from Settings > MCP: every token of the client dies.
      const del = await req(`/api/mcp-clients/${t.clientId}`, {
        method: 'DELETE',
        headers: { cookie: cookie() },
      });
      expect(del.status).toBe(200);
      const after = await mcp(fresh.access_token, 'tools/list');
      expect(after.status).toBe(401);
      expect(after.headers.get('www-authenticate')).toContain('resource_metadata=');
      const dead = await token({
        grant_type: 'refresh_token',
        refresh_token: fresh.refresh_token,
        client_id: t.clientId,
      });
      expect(dead.status).toBe(400);
      expect(await dead.json()).toMatchObject({ error: 'invalid_grant' });
    }, 60_000);
  }
});
