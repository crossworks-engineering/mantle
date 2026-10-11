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
 *
 * W7b fix round 2, M-b: the API keys (mtlk_) by the same switch. The MCP-off
 * login's key is revoked, the Write-off login's key is read-only, the
 * Write-on login's key is as it was. A member and a client login with no
 * switch row (they never reached MCP) keep their keys for /api/v1 only
 * (`api_only`: /api/mcp refuses them) and have their peers disabled. The
 * owner's key and peer (an admin, no row) are untouched, and so is a key or
 * a peer made after the archive.
 *
 * W7b fix round 3: an admin login with a leftover switch row (MCP off, or
 * Write off) keeps its keys as they were (admin keys never went through
 * the switch). A brain with no switch row and no agent records its cutoff
 * on the first run: a second run leaves a key and a peer made after the
 * first run as they are (it used to read now() then).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/mcp-revived-credentials.db.test.ts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0268_workspaces_mcp_one_surface';

type Ts = typeof import('@mantle/db/test-support');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Run 0268 again, in one transaction, as the runner does. */
async function rerun(sql: ReturnType<typeof postgres>): Promise<void> {
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
}

describe.skipIf(!URL)('0268: no MCP credential comes back to life (W7b fix round 1, M3)', () => {
  let scratch: Awaited<ReturnType<Ts['createScratchDatabaseBefore']>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const off = randomUUID(); // MCP off
  const ro = randomUUID(); // MCP on, Write off
  const rw = randomUUID(); // MCP on, Write on
  const client = randomUUID();
  const none = randomUUID(); // a member with no switch row
  const cli = randomUUID(); // a client login with no switch row
  const admOff = randomUUID(); // an admin with a leftover switch row, MCP off
  const admRo = randomUUID(); // an admin with a leftover switch row, Write off
  const tag = `m3${randomUUID().slice(0, 6)}`;
  const tokens: Record<string, { oauth: string; static: string; peer: string }> = {};
  const peerIds: Record<string, string> = {};
  const keys: Record<string, string> = {};
  const keyIds: Record<string, string> = {};

  /** A fresh API key: `mtlk_` + 8 prefix characters + `_` + 43 base64url. */
  const newKey = () =>
    `mtlk_${randomUUID().replace(/-/g, '').slice(0, 8)}_${randomBytes(32).toString('base64url')}`;
  const insertKey = async (
    label: string,
    login: string,
    role: 'admin' | 'member' | 'client',
    access: 'read' | 'read_write' = 'read_write',
  ) => {
    const token = newKey();
    keys[label] = token;
    const prefix = token.slice(5, 13);
    const [row] = await sql`insert into access_keys
        (name, login_id, login_role, key_prefix, key_hash, session_epoch, access, created_by)
      values (${`${tag} ${label} key`}, ${login}, ${role}, ${prefix}, ${sha(token)},
              ${role === 'client' ? 0 : null}, ${access}, ${owner})
      returning id::text`;
    keyIds[label] = row!.id as string;
  };
  const insertPeer = async (label: string, login: string, role: 'admin' | 'member' | 'client') => {
    const token = `mtlpeer_${randomUUID().replace(/-/g, '')}`;
    tokens[label] = { ...(tokens[label] ?? { oauth: '', static: '' }), peer: token };
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
              'https://peer.example.invalid', ${hashToken(token)}, 'active', true,
              ${login}, ${role}, true)`;
  };
  const mcp = async (bearer: string) => {
    const auth = await import('./mcp-auth');
    return auth.resolveMcpCaller(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}` },
      }),
    );
  };

  /** The credential rows the migration may touch. */
  const state = async () =>
    JSON.stringify({
      oauth: await sql`select actor_id::text, scope, revoked_at from oauth_access_tokens
                        order by actor_id`,
      codes: await sql`select actor_id::text from oauth_auth_codes order by actor_id`,
      statics: await sql`select login_id::text, revoked_at from mcp_login_tokens order by login_id`,
      peers: await sql`select id::text, acts_as_login_id::text, enabled, write_enabled
                        from mantle_peers order by id`,
      keys: await sql`select id::text, login_id::text, access, api_only, revoked_at
                       from access_keys order by id`,
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
      (${rw}, ${`${tag}-rw@example.invalid`}, 'x', false, 'member', 'Read write'),
      (${none}, ${`${tag}-none@example.invalid`}, 'x', false, 'member', 'No row'),
      (${cli}, ${`${tag}-cli@example.invalid`}, 'x', false, 'client', 'Client'),
      (${admOff}, ${`${tag}-admoff@example.invalid`}, 'x', false, 'admin', 'Admin off'),
      (${admRo}, ${`${tag}-admro@example.invalid`}, 'x', false, 'admin', 'Admin ro')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await sql`select * from mantle_ws_migrate()`;
    await sql`insert into mcp_login_access (login_id, enabled, write_enabled) values
      (${off}, false, true), (${ro}, true, false), (${rw}, true, true),
      (${admOff}, false, true), (${admRo}, true, false)`;
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
      await insertKey(label, login, 'member');
    }
    // No switch row: a member, a client (each a key and a peer), the owner.
    await insertKey('none', none, 'member');
    await insertPeer('none', none, 'member');
    await insertKey('cli', cli, 'client');
    await insertPeer('cli', cli, 'client');
    await insertKey('owner', owner, 'admin');
    await insertKey('admOff', admOff, 'admin');
    await insertKey('admRo', admRo, 'admin');
    await insertPeer('owner', owner, 'admin');
    // An admin's OAuth grant, code and peer with a leftover switch row (W7
    // integration fix 2): they never went through the switch.
    for (const [login, label] of [
      [admOff, 'admOff'],
      [admRo, 'admRo'],
    ] as const) {
      const oauth = `mtlmcp_at_${randomUUID().replace(/-/g, '')}`;
      tokens[label] = { oauth, static: '', peer: '' };
      await sql`insert into oauth_access_tokens
          (token_hash, owner_id, actor_id, client_id, scope, expires_at, session_epoch)
        values (${sha(oauth)}, ${owner}, ${login}, ${client}, 'mcp',
                now() + interval '1 hour', 0)`;
      await sql`insert into oauth_auth_codes
          (code_hash, client_id, owner_id, actor_id, code_challenge, redirect_uri, expires_at, session_epoch)
        values (${sha(`${oauth}-code`)}, ${client}, ${owner}, ${login}, 'x',
                'https://client.example.invalid/cb', now() + interval '5 minutes', 0)`;
      await insertPeer(label, login, 'admin');
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
    await rerun(sql);
    expect(await state()).toBe(before);
  });

  // ── API keys and the logins with no switch row (W7b fix round 2, M-b) ──────

  it('MCP off: its API key is revoked, and refused at /api/mcp', async () => {
    const [k] = await sql`select revoked_at, api_only from access_keys where id = ${keyIds.off!}`;
    expect(k!.revoked_at).not.toBeNull();
    expect(await mcp(keys.off!)).toBeNull();
  });

  it('Write off: its API key is read-only, on MCP as on /api/v1', async () => {
    const [k] =
      await sql`select access, api_only, revoked_at from access_keys where id = ${keyIds.ro!}`;
    expect(k).toEqual({ access: 'read', api_only: false, revoked_at: null });
    expect(await mcp(keys.ro!)).toMatchObject({ loginId: ro, via: 'key', write: false });
  });

  it('Write on: its API key is as it was', async () => {
    const [k] =
      await sql`select access, api_only, revoked_at from access_keys where id = ${keyIds.rw!}`;
    expect(k).toEqual({ access: 'read_write', api_only: false, revoked_at: null });
    expect(await mcp(keys.rw!)).toMatchObject({ loginId: rw, via: 'key', write: true });
  });

  it('no switch row: the member’s and the client’s keys stay on /api/v1 only', async () => {
    const { verifyAccessKey } = await import('./access-keys');
    for (const label of ['none', 'cli']) {
      const [k] = await sql`select access, api_only, revoked_at from access_keys
                             where id = ${keyIds[label]!}`;
      expect(k, label).toEqual({ access: 'read_write', api_only: true, revoked_at: null });
      // /api/v1 checks the key with verifyAccessKey: it still passes.
      const check = await verifyAccessKey(keys[label]!);
      expect(check.ok, label).toBe(true);
      expect(check.ok && check.grant.apiOnly, label).toBe(true);
      // /api/mcp refuses it.
      expect(await mcp(keys[label]!), label).toBeNull();
    }
  });

  it('no switch row: a peer bound to a member or a client is disabled', async () => {
    for (const label of ['none', 'cli']) {
      const [p] = await sql`select enabled, write_enabled from mantle_peers
                             where id = ${peerIds[label]!}`;
      expect(p, label).toEqual({ enabled: false, write_enabled: true });
      expect(await mcp(tokens[label]!.peer), label).toBeNull();
    }
  });

  it('the owner (an admin, no row): its key and its peer are untouched', async () => {
    const [k] = await sql`select access, api_only, revoked_at from access_keys
                           where id = ${keyIds.owner!}`;
    expect(k).toEqual({ access: 'read_write', api_only: false, revoked_at: null });
    expect(await mcp(keys.owner!)).toMatchObject({
      role: 'admin',
      loginId: owner,
      via: 'key',
      write: true,
    });
    const [p] = await sql`select enabled from mantle_peers where id = ${peerIds.owner!}`;
    expect(p!.enabled).toBe(true);
    expect(await mcp(tokens.owner!.peer)).toMatchObject({ loginId: owner, via: 'peer' });
  });

  it('an admin with a leftover switch row keeps its keys (W7b fix round 3)', async () => {
    for (const [label, login] of [
      ['admOff', admOff],
      ['admRo', admRo],
    ] as const) {
      const [k] = await sql`select access, api_only, revoked_at from access_keys
                             where id = ${keyIds[label]!}`;
      expect(k, label).toEqual({ access: 'read_write', api_only: false, revoked_at: null });
      expect(await mcp(keys[label]!), label).toMatchObject({
        role: 'admin',
        loginId: login,
        via: 'key',
        write: true,
      });
    }
  });

  it('an admin with a leftover switch row keeps its OAuth grant, code and peer (W7 integration fix 2)', async () => {
    for (const label of ['admOff', 'admRo'] as const) {
      const token = tokens[label]!.oauth;
      const [g] = await sql`select scope, revoked_at from oauth_access_tokens
                             where token_hash = ${sha(token)}`;
      expect(g, label).toEqual({ scope: 'mcp', revoked_at: null });
      const codes = await sql`select 1 from oauth_auth_codes where code_hash = ${sha(`${token}-code`)}`;
      expect(codes.length, label).toBe(1);
      const [p] = await sql`select enabled, write_enabled from mantle_peers
                             where id = ${peerIds[label]!}`;
      expect(p, label).toEqual({ enabled: true, write_enabled: true });
    }
  });

  it('a key and a peer made after the archive: a second run leaves them be', async () => {
    await insertKey('later', none, 'member');
    await insertPeer('later', none, 'member');
    const before = await state();
    await rerun(sql);
    expect(await state()).toBe(before);
    const [k] = await sql`select api_only, revoked_at from access_keys where id = ${keyIds.later!}`;
    expect(k).toEqual({ api_only: false, revoked_at: null });
    expect(await mcp(keys.later!)).toMatchObject({ loginId: none, via: 'key', write: true });
    const [p] = await sql`select enabled from mantle_peers where id = ${peerIds.later!}`;
    expect(p!.enabled).toBe(true);
  });
});

describe.skipIf(!URL)('0268: the cutoff is recorded once (W7b fix round 3)', () => {
  let scratch: Awaited<ReturnType<Ts['createScratchDatabaseBefore']>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID(); // no switch row
  const tag = `ct${randomUUID().slice(0, 6)}`;

  const insertKey = async (label: string) => {
    const token = `mtlk_${randomUUID().replace(/-/g, '').slice(0, 8)}_${randomBytes(32).toString('base64url')}`;
    const [row] = await sql`insert into access_keys
        (name, login_id, login_role, key_prefix, key_hash, session_epoch, access, created_by)
      values (${`${tag} ${label} key`}, ${member}, 'member', ${token.slice(5, 13)},
              ${sha(token)}, null, 'read_write', ${owner})
      returning id::text`;
    return row!.id as string;
  };
  const insertPeer = async (label: string) => {
    const { hashToken } = await import('@mantle/content/peers-crypto');
    const peerNode = randomUUID();
    const peerId = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path)
      values (${peerNode}, ${owner}, 'mantle_peer', ${`${tag} ${label} peer`}, 'peers')`;
    await sql`insert into mantle_peers
        (id, owner_id, node_id, display_name, base_url, inbound_token_hash, status, enabled,
         acts_as_login_id, acts_as_role, write_enabled)
      values (${peerId}, ${owner}, ${peerNode}, ${`${tag} ${label} peer`},
              'https://peer.example.invalid',
              ${hashToken(`mtlpeer_${randomUUID().replace(/-/g, '')}`)}, 'active', true,
              ${member}, 'member', true)`;
    return peerId;
  };
  const state = async () =>
    JSON.stringify({
      cutoff: await sql`select archived_at from archive_mcp_cutoff`,
      peers: await sql`select id::text, enabled, write_enabled from mantle_peers order by id`,
      keys: await sql`select id::text, access, api_only, revoked_at from access_keys order by id`,
    });

  let beforeKey = '';
  let beforePeer = '';

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${member}, ${`${tag}-member@example.invalid`}, 'x', false, 'member', 'Member')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await sql`select * from mantle_ws_migrate()`;
    beforeKey = await insertKey('before');
    beforePeer = await insertPeer('before');
    await scratch.migrateRest();
  }, 300_000);

  afterAll(async () => {
    await sql?.end().catch(() => {});
    await scratch?.drop();
  }, 120_000);

  it('a brain with no switch row and no agent: the first run records its cutoff', async () => {
    const [a] = await sql`select
        (select count(*)::int from archive_mcp_login_access) as switches,
        (select count(*)::int from archive_tool_levels) as levels,
        (select count(*)::int from archive_mcp_cutoff) as cutoffs`;
    expect(a).toEqual({ switches: 0, levels: 0, cutoffs: 1 });
    const [k] = await sql`select api_only, revoked_at from access_keys where id = ${beforeKey}`;
    expect(k).toEqual({ api_only: true, revoked_at: null });
    const [p] = await sql`select enabled from mantle_peers where id = ${beforePeer}`;
    expect(p!.enabled).toBe(false);
  });

  it('a second run leaves a key and a peer made after the first run as they are', async () => {
    const laterKey = await insertKey('later');
    const laterPeer = await insertPeer('later');
    const before = await state();
    await rerun(sql);
    expect(await state()).toBe(before);
    const [k] = await sql`select api_only, revoked_at from access_keys where id = ${laterKey}`;
    expect(k).toEqual({ api_only: false, revoked_at: null });
    const [p] = await sql`select enabled from mantle_peers where id = ${laterPeer}`;
    expect(p!.enabled).toBe(true);
  });
});
