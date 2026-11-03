/**
 * The status link from the shell (scripts/peer-link.ts, migration 0354;
 * docs/federation.md "Status links") on a real migrated Postgres:
 *
 *  - create --status-only prints the peer id and its token once; the token
 *    verifies, reaches /api/mcp as a status-only caller (the owner,
 *    read-only) and never the federation routes;
 *  - create --outbound-only --watch prints no token, and an outbound-only
 *    peer's token verifies nowhere;
 *  - accept reads the other box's token from stdin (never argv) and makes
 *    the peer active; list shows no secret; revoke closes both directions;
 *  - each change leaves its audit row, which names no token;
 *  - the column: an existing peer is `full`, and a value outside the three
 *    is refused by the CHECK.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/scripts/peer-link.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureAdminUsers, ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

// The outbound token is sealed with the box's master key; the test key is
// the viewer roles' and is not a sealing key.
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => 'peer-link-sealed-value'),
}));

type Lines = { out: string[]; err: string[] };

describe.skipIf(!URL)('peer-link: the status link from the shell', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof ensureAdminUsers>[0];
  let anchor = '';
  const tag = `peer-link-${randomUUID().slice(0, 8)}`;
  const made: string[] = [];

  async function cli(argv: string[], stdin = ''): Promise<{ code: number } & Lines> {
    const { parseArgs, run } = await import('./peer-link');
    const lines: Lines = { out: [], err: [] };
    const code = await run(parseArgs(argv), {
      out: (l) => lines.out.push(l),
      err: (l) => lines.err.push(l),
      stdin: async () => stdin,
    });
    return { code, ...lines };
  }

  const value = (lines: string[], key: string) =>
    lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;

  const row = async (id: string) =>
    (
      (await sql`select access_scope, watch_status, enabled, status,
                        outbound_token_enc is not null as has_outbound
                   from mantle_peers where id = ${id}`) as unknown as Record<string, unknown>[]
    )[0]!;

  const audits = async (peerId: string) =>
    (await sql`select action, detail from audit_log
                where action like 'peer.%' and detail->>'peerId' = ${peerId}
                order by created_at`) as unknown as { action: string; detail: unknown }[];

  const bearer = (token: string) =>
    new Request('http://x/api/mcp', { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'peer-link-db-test-secret-at-least-32-chars';
    m = await import('@mantle/db');
    // Fixtures go through their own superuser client, not the app pool: under
    // the runtime-role lane the app pool logs in as mantle_runtime.
    sql = postgres(URL!, { max: 2, prepare: false, onnotice: () => {} }) as unknown as typeof sql;
    anchor = await ensureTestAnchor(sql);
    // The owner is an Admin login (a user of the Admin workspace): what a
    // status peer runs as.
    await ensureAdminUsers(sql, [anchor]);
  }, 120_000);

  afterAll(async () => {
    if (made.length > 0) {
      await sql`delete from nodes where id in (select node_id from mantle_peers where id in ${sql(made)})`;
    }
    await (sql as unknown as { end(): Promise<void> }).end();
    await m.closeDb();
  });

  let statusToken = '';
  let statusPeer = '';

  it('create --status-only: the id and the token once; a status-only caller on /api/mcp only', async () => {
    const res = await cli([
      'create',
      '--name',
      `${tag} admin`,
      '--url',
      'https://admin.example.com',
      '--status-only',
    ]);
    expect(res.code).toBe(0);
    statusPeer = value(res.out, 'peer_id')!;
    statusToken = value(res.out, 'token')!;
    made.push(statusPeer);
    expect(statusToken).toMatch(/^mtlpeer_/);
    expect(res.out.filter((l) => l.includes(statusToken))).toHaveLength(1);
    expect(res.err.join('\n')).not.toContain(statusToken);
    expect(await row(statusPeer)).toMatchObject({
      access_scope: 'status',
      watch_status: false,
      enabled: true,
      status: 'pending',
      has_outbound: false,
    });

    const { verifyInboundToken } = await import('@mantle/content');
    expect((await verifyInboundToken(statusToken))?.id).toBe(statusPeer);
    const { authenticatePeer } = await import('../lib/federation-auth');
    expect(await authenticatePeer(bearer(statusToken))).toBeNull();
    const { resolveMcpCaller } = await import('../lib/mcp-auth');
    expect(await resolveMcpCaller(bearer(statusToken))).toMatchObject({
      via: 'peer',
      peerId: statusPeer,
      loginId: anchor,
      anchorId: anchor,
      write: false,
      riskyAllowed: [],
      statusOnly: true,
    });

    const rows = await audits(statusPeer);
    expect(rows.map((r) => r.action)).toEqual(['peer.linked']);
    expect(JSON.stringify(rows)).not.toContain('mtlpeer_');
  }, 60_000);

  it('a duplicate name is refused', async () => {
    const res = await cli([
      'create',
      '--name',
      `${tag} ADMIN`,
      '--url',
      'https://admin.example.com',
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toEqual([]);
  });

  it('create --outbound-only --watch: no token; accept from stdin; list shows no secret', async () => {
    const res = await cli([
      'create',
      '--name',
      `${tag} box1`,
      '--url',
      'https://box1.example.com',
      '--outbound-only',
      '--watch',
    ]);
    expect(res.code).toBe(0);
    const id = value(res.out, 'peer_id')!;
    made.push(id);
    expect(value(res.out, 'token')).toBeNull();
    expect(await row(id)).toMatchObject({ access_scope: 'none', watch_status: true });

    const accepted = await cli(
      ['accept', '--peer', `${tag} box1`],
      'token=mtlpeer_from-the-other-box\n',
    );
    expect(accepted.code).toBe(0);
    expect(value(accepted.out, 'status')).toBe('active');
    expect(await row(id)).toMatchObject({ status: 'active', has_outbound: true });
    expect((await audits(id)).map((r) => r.action)).toEqual(['peer.linked', 'peer.accepted']);

    const bad = await cli(['accept', '--peer', id], 'not a token\n');
    expect(bad.code).toBe(1);

    const list = await cli(['list']);
    expect(list.code).toBe(0);
    expect(list.out.join('\n')).not.toContain('mtlpeer_');
    expect(list.out.some((l) => l.startsWith(`peer_id=${id} `) && l.includes('watch=yes'))).toBe(
      true,
    );
    const json = await cli(['list', '--json']);
    expect(json.out.join('\n')).not.toContain('mtlpeer_');
  }, 60_000);

  it("an outbound-only peer's token verifies nowhere", async () => {
    const { createPeer, verifyInboundToken } = await import('@mantle/content');
    const { peer, inboundToken } = await createPeer(anchor, {
      displayName: `${tag} outbound`,
      baseUrl: 'https://box2.example.com',
      accessScope: 'none',
    });
    made.push(peer.id);
    expect(await verifyInboundToken(inboundToken)).toBeNull();
    const { resolveMcpCaller } = await import('../lib/mcp-auth');
    expect(await resolveMcpCaller(bearer(inboundToken))).toBeNull();
  });

  it('revoke closes the status peer: its token verifies no more', async () => {
    const res = await cli(['revoke', '--peer', statusPeer]);
    expect(res.code).toBe(0);
    expect(await row(statusPeer)).toMatchObject({ enabled: false, status: 'revoked' });
    const { verifyInboundToken } = await import('@mantle/content');
    expect(await verifyInboundToken(statusToken)).toBeNull();
    expect((await audits(statusPeer)).map((r) => r.action)).toEqual([
      'peer.linked',
      'peer.revoked',
    ]);
  }, 60_000);

  it('the column: a peer made without it is full; a value outside the three is refused', async () => {
    const node = randomUUID();
    const id = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path)
              values (${node}, ${anchor}, 'mantle_peer', ${`${tag} plain`}, 'peers')`;
    await sql`insert into mantle_peers (id, owner_id, node_id, display_name, base_url, inbound_token_hash)
              values (${id}, ${anchor}, ${node}, ${`${tag} plain`}, 'https://peer.example.com', ${`${tag}-h`})`;
    made.push(id);
    expect(await row(id)).toMatchObject({ access_scope: 'full', watch_status: false });
    await expect(
      sql`update mantle_peers set access_scope = 'everything' where id = ${id}`,
    ).rejects.toThrow(/mantle_peers_access_scope_ck/);
  });
});
