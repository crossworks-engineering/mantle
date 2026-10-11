/**
 * W7b fix round 1, M3: no MCP credential comes back to life when the
 * per-login MCP switch goes (migration 0268). A scratch brain is migrated up
 * to 0268 and given, before it runs: a login whose MCP was off, one on with
 * Write off, one on with Write on, each with an OAuth grant, a static login
 * token and a peer bound to it. Then 0268 runs. Checked: every static token
 * is revoked (and refused at /api/mcp); the MCP-off login's grant is revoked
 * and its peer disabled; the Write-off login's grant and peer are read-only
 * (the caller resolves with write off); the Write-on login keeps its grant
 * and peer as they were; nothing else changes, and a second run changes
 * nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/mcp-revived-credentials.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0268_workspaces_mcp_one_surface';

type Ts = typeof import('@mantle/db/test-support');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe.skipIf(!URL)('0268: no MCP credential comes back to life (W7b fix round 1, M3)', () => {
  let scratch: Awaited<ReturnType<Ts['createScratchDatabaseBefore']>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const off = randomUUID(); // MCP off
  const ro = randomUUID(); // MCP on, Write off
  const rw = randomUUID(); // MCP on, Write on
  const client = randomUUID();
  const tag = `m3${randomUUID().slice(0, 6)}`;
  const tokens: Record<string, { oauth: string; static: string; peer: string }> = {};
  const peerIds: Record<string, string> = {};

  /** The credential rows the migration may touch. */
  const state = async () =>
    JSON.stringify({
      oauth: await sql`select actor_id::text, scope, revoked_at from oauth_access_tokens
                        order by actor_id`,
      codes: await sql`select actor_id::text from oauth_auth_codes order by actor_id`,
      statics: await sql`select login_id::text, revoked_at from mcp_login_tokens order by login_id`,
      peers: await sql`select acts_as_login_id::text, enabled, write_enabled from mantle_peers
                        order by acts_as_login_id`,
      nodes: await sql`select count(*)::int as n from nodes`,
    });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${off}, ${`${tag}-off@example.invalid`}, 'x', false, 'member', 'Off'),
      (${ro}, ${`${tag}-ro@example.invalid`}, 'x', false, 'member', 'Read only'),
      (${rw}, ${`${tag}-rw@example.invalid`}, 'x', false, 'member', 'Read write')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await sql`select * from mantle_ws_migrate()`;
    await sql`insert into mcp_login_access (login_id, enabled, write_enabled) values
      (${off}, false, true), (${ro}, true, false), (${rw}, true, true)`;
    await sql`insert into oauth_clients (id, client_name, redirect_uris)
      values (${client}, ${`${tag} client`}, ${['https://client.example.invalid/cb']})`;
    for (const [login, label] of [
      [off, 'off'],
      [ro, 'ro'],
      [rw, 'rw'],
    ] as const) {
      const t = {
        oauth: `mtlmcp_at_${randomUUID().replace(/-/g, '')}`,
        static: `mtlmcpk_${randomUUID().replace(/-/g, '')}`,
        peer: `mtlpeer_${randomUUID().replace(/-/g, '')}`,
      };
      tokens[label] = t;
      await sql`insert into oauth_access_tokens
          (token_hash, owner_id, actor_id, client_id, scope, expires_at, session_epoch)
        values (${sha(t.oauth)}, ${owner}, ${login}, ${client}, 'mcp',
                now() + interval '1 hour', 0)`;
      await sql`insert into oauth_auth_codes
          (code_hash, client_id, owner_id, actor_id, code_challenge, redirect_uri, expires_at, session_epoch)
        values (${sha(`${t.oauth}-code`)}, ${client}, ${owner}, ${login}, 'x',
                'https://client.example.invalid/cb', now() + interval '5 minutes', 0)`;
      await sql`insert into mcp_login_tokens (login_id, token_hash, session_epoch, created_by)
        values (${login}, ${sha(t.static)}, 0, ${owner})`;
      const peerNode = randomUUID();
      const peerId = randomUUID();
      peerIds[label] = peerId;
      await sql`insert into nodes (id, owner_id, type, title, path)
        values (${peerNode}, ${owner}, 'mantle_peer', ${`${tag} ${label} peer`}, 'peers')`;
      const { hashToken } = await import('@mantle/content/peers-crypto');
      await sql`insert into mantle_peers
          (id, owner_id, node_id, display_name, base_url, inbound_token_hash, status, enabled,
           acts_as_login_id, acts_as_role, write_enabled)
        values (${peerId}, ${owner}, ${peerNode}, ${`${tag} ${label} peer`},
                'https://peer.example.invalid', ${hashToken(t.peer)}, 'active', true,
                ${login}, 'member', true)`;
    }
    await scratch.migrateRest();
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'mcp-revived-credentials-secret-32-chars!!';
  }, 300_000);

  afterAll(async () => {
    const m = await import('@mantle/db');
    await m.closeDb().catch(() => {});
    await sql?.end().catch(() => {});
    await scratch?.drop();
  }, 120_000);

  it('every static login token is revoked, and refused at /api/mcp', async () => {
    const live =
      await sql`select count(*)::int as n from mcp_login_tokens where revoked_at is null`;
    expect(live[0]!.n).toBe(0);
    const auth = await import('./mcp-auth');
    for (const label of ['off', 'ro', 'rw']) {
      const caller = await auth.resolveMcpCaller(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${tokens[label]!.static}` },
        }),
      );
      expect(caller, label).toBeNull();
    }
  });

  it('MCP off: its OAuth grant is revoked, its codes gone, its peer disabled', async () => {
    const [g] = await sql`select revoked_at from oauth_access_tokens where actor_id = ${off}`;
    expect(g!.revoked_at).not.toBeNull();
    const codes = await sql`select 1 from oauth_auth_codes where actor_id = ${off}`;
    expect(codes.length).toBe(0);
    const [p] = await sql`select enabled from mantle_peers where id = ${peerIds.off!}`;
    expect(p!.enabled).toBe(false);
    const auth = await import('./mcp-auth');
    for (const bearer of [tokens.off!.oauth, tokens.off!.peer]) {
      const caller = await auth.resolveMcpCaller(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}` },
        }),
      );
      expect(caller).toBeNull();
    }
  });

  it('Write off: the grant and the peer stay, read-only', async () => {
    const [g] = await sql`select revoked_at, scope from oauth_access_tokens where actor_id = ${ro}`;
    expect(g!.revoked_at).toBeNull();
    expect(String(g!.scope).split(' ')).toContain('mantle:read-only');
    const [p] =
      await sql`select enabled, write_enabled from mantle_peers where id = ${peerIds.ro!}`;
    expect(p).toEqual({ enabled: true, write_enabled: false });
    const auth = await import('./mcp-auth');
    for (const [bearer, via] of [
      [tokens.ro!.oauth, 'oauth'],
      [tokens.ro!.peer, 'peer'],
    ] as const) {
      const caller = await auth.resolveMcpCaller(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}` },
        }),
      );
      expect(caller, via).toMatchObject({ loginId: ro, via, write: false });
    }
  });

  it('Write on: the grant and the peer are as they were', async () => {
    const [g] = await sql`select revoked_at, scope from oauth_access_tokens where actor_id = ${rw}`;
    expect(g).toEqual({ revoked_at: null, scope: 'mcp' });
    const [p] =
      await sql`select enabled, write_enabled from mantle_peers where id = ${peerIds.rw!}`;
    expect(p).toEqual({ enabled: true, write_enabled: true });
    const auth = await import('./mcp-auth');
    const caller = await auth.resolveMcpCaller(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.rw!.oauth}` },
      }),
    );
    expect(caller).toMatchObject({ loginId: rw, via: 'oauth', write: true });
  });

  it('a second run changes nothing', async () => {
    const before = await state();
    const file = readFileSync(
      fileURLToPath(
        new globalThis.URL(`../../../packages/db/migrations/${TAG}.sql`, import.meta.url),
      ),
      'utf8',
    );
    await sql.begin(async (tx) => {
      for (const stmt of file.split('--> statement-breakpoint')) {
        if (stmt.trim()) await tx.unsafe(stmt);
      }
    });
    expect(await state()).toBe(before);
  });
});
