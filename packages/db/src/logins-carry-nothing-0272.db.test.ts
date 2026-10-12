/**
 * 0272 (workspaces W8a): a login carries nothing, on a scratch database
 * migrated to just before it.
 *
 *  - a client login is archived (its auth row, no password hash), then
 *    ended: disabled, its epoch bumped, its device tokens, API keys and
 *    OAuth grants revoked, its OAuth codes and push devices deleted, its
 *    peers unbound and switched off (Write off, no risky tools: W8a fix
 *    round 1, L3); its role becomes member and the role
 *    CHECK admits admin and member only; nobody is added to a workspace and
 *    no notify fires;
 *  - the email-code tables and the static login tokens are archived (every
 *    row, metadata only) and dropped; the role a key or a peer was made
 *    under is archived and its column dropped;
 *  - a key or a peer the old role check refused (its login's role changed
 *    since) is ended first, so it does not come back to life;
 *  - a member's and the owner's credentials are left exactly as they were;
 *  - re-runnable: a second run changes nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/logins-carry-nothing-0272.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0272_workspaces_logins_carry_nothing';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe.skipIf(!URL)('0272: logins carry nothing', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const moved = randomUUID();
  const client = randomUUID();
  const peerNode = {
    member: randomUUID(),
    client: randomUUID(),
    moved: randomUUID(),
    owner: randomUUID(),
  };
  const peer = {
    member: randomUUID(),
    client: randomUUID(),
    moved: randomUUID(),
    owner: randomUUID(),
  };
  const key = {
    member: randomUUID(),
    client: randomUUID(),
    moved: randomUUID(),
    owner: randomUUID(),
  };
  const device = { member: randomUUID(), client: randomUUID() };
  const oauthClient = randomUUID();
  const account = randomUUID();
  const heard: string[] = [];
  let listener: Awaited<ReturnType<ReturnType<typeof postgres>['listen']>> | undefined;
  let clientBefore: { session_epoch: number; email: string } | undefined;
  let wsUsersBefore = 0;

  const run = async () => {
    const file = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', `${TAG}.sql`),
      'utf8',
    );
    const statements = file
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean);
    await sql.begin(async (tx) => {
      for (const stmt of statements) await tx.unsafe(stmt);
    });
  };

  /** Everything the migration may touch, as plain rows. */
  const snapshot = async () => ({
    users: await sql`select id::text, role, disabled_at::text, session_epoch from auth.users
                      where id in ${sql([owner, member, moved, client])} order by id`,
    tokens: await sql`select id::text, revoked_at::text from mobile_tokens
                       where user_id in ${sql([owner, member, moved, client])} order by id`,
    keys: await sql`select id::text, revoked_at::text, access, risky_tools from access_keys
                     where login_id in ${sql([owner, member, moved, client])} order by id`,
    peers: await sql`select id::text, acts_as_login_id::text, ended_acts_as_login_id::text,
                            enabled, write_enabled, allowed_risky_tools
                       from mantle_peers where id in ${sql(Object.values(peer))} order by id`,
    grants: await sql`select id::text, revoked_at::text from oauth_access_tokens
                       where actor_id in ${sql([member, client])} order by id`,
    codes: await sql`select count(*)::int as n from oauth_auth_codes
                      where actor_id in ${sql([member, client])}`,
    push: await sql`select id::text from push_subscriptions
                     where login_id in ${sql([member, client])} order by id`,
    archives: await sql`select
        (select count(*)::int from archive_client_logins) as logins,
        (select count(*)::int from archive_client_signin_codes) as codes,
        (select count(*)::int from archive_client_signin_code_skips) as skips,
        (select count(*)::int from archive_client_signin_sender_folders) as folders,
        (select count(*)::int from archive_mcp_login_tokens) as statics,
        (select count(*)::int from archive_key_roles) as key_roles,
        (select count(*)::int from archive_peer_roles) as peer_roles`,
    wsUsers: await sql`select count(*)::int as n from workspace_users`,
  });

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner, display_name) values
      (${owner}, 'w8a-owner@example.invalid', 'x', 'admin', true, 'Owner'),
      (${member}, 'w8a-member@example.invalid', 'x', 'member', false, 'Member'),
      (${moved}, 'w8a-moved@example.invalid', 'x', 'member', false, 'Moved'),
      (${client}, 'w8a-client@example.invalid', 'x', 'client', false, 'Client')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    for (const k of Object.keys(peerNode) as Array<keyof typeof peerNode>) {
      await sql`insert into nodes (id, owner_id, type, title, path)
        values (${peerNode[k]}, ${owner}, 'mantle_peer', ${`w8a peer ${k}`}, 'peers')`;
    }
    // Device tokens.
    for (const [id, login] of [
      [device.member, member],
      [device.client, client],
    ] as const) {
      await sql`insert into mobile_tokens (id, user_id, label, expires_at)
        values (${id}, ${login}, 'w8a', now() + interval '30 days')`;
    }
    // API keys: the member's and the owner's (risky tools) as they are; the
    // client's (with its session epoch); one made when `moved` was an admin.
    const insertKey = (
      id: string,
      login: string,
      role: string,
      risky: string[],
      epoch: number | null,
    ) =>
      sql`insert into access_keys
            (id, name, login_id, login_role, key_prefix, key_hash, access, risky_tools,
             session_epoch, created_by)
          values (${id}, 'w8a', ${login}, ${role}, ${id.replace(/-/g, '').slice(0, 8)},
                  ${sha(id)}, 'read_write', ${risky}, ${epoch}, ${login})`;
    await insertKey(key.member, member, 'member', [], null);
    await insertKey(key.owner, owner, 'admin', ['app_file_write'], null);
    await insertKey(key.client, client, 'client', [], 0);
    await insertKey(key.moved, moved, 'admin', ['app_file_write'], null);
    // Peers bound to each, with the role at bind.
    const insertPeer = (id: string, node: string, login: string, role: string) =>
      sql`insert into mantle_peers
            (id, owner_id, node_id, display_name, base_url, inbound_token_hash, status, enabled,
             acts_as_login_id, acts_as_role, write_enabled)
          values (${id}, ${owner}, ${node}, ${`w8a ${id.slice(0, 8)}`}, 'https://peer.example.invalid',
                  ${sha(`peer-${id}`)}, 'active', true, ${login}, ${role}, true)`;
    await insertPeer(peer.member, peerNode.member, member, 'member');
    await insertPeer(peer.owner, peerNode.owner, owner, 'admin');
    await insertPeer(peer.client, peerNode.client, client, 'client');
    await insertPeer(peer.moved, peerNode.moved, moved, 'admin');
    // The client's peer may run a risky tool (W8a fix round 1, L3).
    await sql`update mantle_peers set allowed_risky_tools = ${['app_file_write']}
               where id = ${peer.client}`;
    // OAuth: a grant and an open code of the member and of the client.
    await sql`insert into oauth_clients (id, client_name, redirect_uris)
      values (${oauthClient}, 'w8a', ${['https://app.example.invalid/cb']})`;
    for (const login of [member, client]) {
      await sql`insert into oauth_access_tokens
          (token_hash, owner_id, actor_id, client_id, expires_at, session_epoch)
        values (${sha(`at-${login}`)}, ${owner}, ${login}, ${oauthClient},
                now() + interval '1 hour', 0)`;
      await sql`insert into oauth_auth_codes
          (code_hash, client_id, owner_id, actor_id, code_challenge, redirect_uri, expires_at)
        values (${sha(`code-${login}`)}, ${oauthClient}, ${owner}, ${login}, 'x',
                'https://app.example.invalid/cb', now() + interval '1 minute')`;
      await sql`insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform)
        values (${owner}, ${login}, ${`w8a-${login}`}, 'pk', 'ios')`;
    }
    // The email-code sign-in rows and a static login token.
    for (const kind of ['email', 'admin_link'] as const) {
      await sql`insert into client_signin_codes
          (owner_id, login_id, kind, code_hash, request_ip, expires_at, sent_at)
        values (${owner}, ${client}, ${kind}, ${sha(`csc-${kind}`)}, '198.51.100.7',
                now() + interval '10 minutes', now())`;
    }
    await sql`insert into client_signin_code_skips (reason) values ('per-login')`;
    await sql`insert into email_accounts (id, user_id, provider, address, branch_path)
      values (${account}, ${owner}, 'imap', 'w8a-sender@example.invalid', 'inbox.w8a')`;
    await sql`insert into client_signin_sender_folders (account_id, folders)
      values (${account}, ${['Sent']})`;
    await sql`insert into mcp_login_tokens (login_id, token_hash, session_epoch, created_by)
      values (${member}, ${sha('mtlmcpk-w8a')}, 0, ${owner})`;

    [clientBefore] = (await sql`select session_epoch, email from auth.users
                                 where id = ${client}`) as unknown as Array<{
      session_epoch: number;
      email: string;
    }>;
    [{ n: wsUsersBefore }] =
      (await sql`select count(*)::int as n from workspace_users`) as unknown as [{ n: number }];
    listener = await sql.listen('needs_you_changed', (payload) => heard.push(payload));
    await run();
  }, 300_000);

  afterAll(async () => {
    await listener?.unlisten().catch(() => {});
    await sql?.end();
    await scratch?.drop();
  });

  it('archives the client login, then ends it as End sessions and Disable do', async () => {
    const [archived] = await sql`select login_id::text, email, display_name, session_epoch
                                   from archive_client_logins where login_id = ${client}`;
    expect(archived).toEqual({
      login_id: client,
      email: clientBefore!.email,
      display_name: 'Client',
      session_epoch: clientBefore!.session_epoch,
    });
    const cols = (
      await sql`select column_name from information_schema.columns
                 where table_schema = 'public' and table_name = 'archive_client_logins'`
    ).map((r) => r.column_name as string);
    expect(cols).not.toContain('password_hash');
    const [row] = await sql`select role, disabled_at is not null as disabled, session_epoch
                              from auth.users where id = ${client}`;
    expect(row).toEqual({
      role: 'member',
      disabled: true,
      session_epoch: clientBefore!.session_epoch + 1,
    });
    const [tok] =
      await sql`select revoked_at is not null as r from mobile_tokens where id = ${device.client}`;
    expect(tok!.r).toBe(true);
    const [k] =
      await sql`select revoked_at is not null as r from access_keys where id = ${key.client}`;
    expect(k!.r).toBe(true);
    const grants = await sql`select revoked_at is not null as r from oauth_access_tokens
                              where actor_id = ${client}`;
    expect(grants.map((g) => g.r)).toEqual([true]);
    expect(await sql`select 1 from oauth_auth_codes where actor_id = ${client}`).toHaveLength(0);
    expect(await sql`select 1 from push_subscriptions where login_id = ${client}`).toHaveLength(0);
    // Unbound, off, its Write off and its risky tools cleared (L3), as a
    // peer the old role check refused (step 3).
    const [p] =
      await sql`select acts_as_login_id::text as a, ended_acts_as_login_id::text as e, enabled,
                       write_enabled, allowed_risky_tools
                  from mantle_peers where id = ${peer.client}`;
    expect(p).toEqual({
      a: null,
      e: client,
      enabled: false,
      write_enabled: false,
      allowed_risky_tools: [],
    });
  });

  it('admits admin and member only, adds nobody to a workspace, and notifies nothing', async () => {
    await expect(
      sql`insert into auth.users (id, email, password_hash, role)
          values (${randomUUID()}, 'w8a-new-client@example.invalid', 'x', 'client')`,
    ).rejects.toMatchObject({ code: '23514' });
    const [{ n }] = (await sql`select count(*)::int as n from workspace_users`) as unknown as [
      { n: number },
    ];
    expect(n).toBe(wsUsersBefore);
    const guard = await sql`select 1 from pg_trigger where tgname = 'users_client_role_guard'`;
    expect(guard).toHaveLength(0);
    // The triggers it quieted for its one UPDATE are on again.
    const off = await sql`select tgname from pg_trigger
                           where tgrelid = 'auth.users'::regclass and not tgisinternal
                             and tgenabled = 'D'`;
    expect(off).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(heard).toEqual([]);
  });

  it('archives the sign-in tables and the static tokens as metadata, then drops them', async () => {
    for (const t of [
      'client_signin_codes',
      'client_signin_code_skips',
      'client_signin_sender_folders',
      'mcp_login_tokens',
    ]) {
      const [r] = await sql`select to_regclass(${`public.${t}`})::text as t`;
      expect(r!.t, t).toBeNull();
    }
    const [a] = await sql`select
        (select count(*)::int from archive_client_signin_codes) as codes,
        (select count(*)::int from archive_client_signin_code_skips) as skips,
        (select count(*)::int from archive_client_signin_sender_folders) as folders,
        (select count(*)::int from archive_mcp_login_tokens) as statics`;
    expect(a).toEqual({ codes: 2, skips: 1, folders: 1, statics: 1 });
    const secretCols = await sql`select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and table_name in ('archive_client_signin_codes', 'archive_mcp_login_tokens')
         and column_name in ('code_hash', 'token_hash', 'request_id', 'request_ip')`;
    expect(secretCols).toHaveLength(0);
  });

  it('archives the role of every key and peer, drops the columns, and ends what the role check refused', async () => {
    const gone = await sql`select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'access_keys' and column_name = 'login_role')
           or (table_name = 'mantle_peers' and column_name in ('acts_as_role', 'ended_acts_as_role')))`;
    expect(gone).toHaveLength(0);
    const keyRoles = await sql`select key_id::text as id, login_role from archive_key_roles
                                where key_id in ${sql(Object.values(key))} order by key_id`;
    expect(new Map(keyRoles.map((r) => [r.id, r.login_role]))).toEqual(
      new Map([
        [key.member, 'member'],
        [key.owner, 'admin'],
        [key.client, 'client'],
        [key.moved, 'admin'],
      ]),
    );
    const peerRoles = await sql`select peer_id::text as id, acts_as_role from archive_peer_roles
                                 where peer_id in ${sql(Object.values(peer))}`;
    expect(new Map(peerRoles.map((r) => [r.id, r.acts_as_role]))).toEqual(
      new Map([
        [peer.member, 'member'],
        [peer.owner, 'admin'],
        [peer.client, 'client'],
        [peer.moved, 'admin'],
      ]),
    );
    // Made when `moved` was an admin: refused by the role check, so ended.
    const [mk] =
      await sql`select revoked_at is not null as r from access_keys where id = ${key.moved}`;
    expect(mk!.r).toBe(true);
    const [mp] = await sql`select acts_as_login_id, write_enabled, allowed_risky_tools
                             from mantle_peers where id = ${peer.moved}`;
    expect(mp).toEqual({ acts_as_login_id: null, write_enabled: false, allowed_risky_tools: [] });
  });

  it("leaves a member's and the owner's credentials as they were", async () => {
    const [mt] = await sql`select revoked_at from mobile_tokens where id = ${device.member}`;
    expect(mt!.revoked_at).toBeNull();
    const keys = await sql`select id::text, revoked_at, risky_tools from access_keys
                            where id in ${sql([key.member, key.owner])} order by id`;
    for (const k of keys) expect(k.revoked_at, k.id).toBeNull();
    expect(keys.find((k) => k.id === key.owner)?.risky_tools).toEqual(['app_file_write']);
    const peers = await sql`select id::text, acts_as_login_id::text as a, enabled, write_enabled
                             from mantle_peers where id in ${sql([peer.member, peer.owner])}`;
    expect(new Map(peers.map((p) => [p.id, [p.a, p.enabled, p.write_enabled]]))).toEqual(
      new Map([
        [peer.member, [member, true, true]],
        [peer.owner, [owner, true, true]],
      ]),
    );
    const [g] = await sql`select revoked_at from oauth_access_tokens where actor_id = ${member}`;
    expect(g!.revoked_at).toBeNull();
    expect(await sql`select 1 from oauth_auth_codes where actor_id = ${member}`).toHaveLength(1);
    expect(await sql`select 1 from push_subscriptions where login_id = ${member}`).toHaveLength(1);
    const [u] =
      await sql`select role, disabled_at, session_epoch from auth.users where id = ${member}`;
    expect(u).toEqual({ role: 'member', disabled_at: null, session_epoch: 0 });
  });

  it('a second run changes nothing', async () => {
    const before = await snapshot();
    await run();
    expect(await snapshot()).toEqual(before);
    expect(heard).toEqual([]);
  }, 120_000);
});
