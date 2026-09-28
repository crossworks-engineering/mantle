/**
 * Member logins Phase 6 stage 6 on a real, migrated Postgres: team links are
 * retired. Migration 0176 (re-run here on seeded rows: it only writes rows
 * with no revoked_at, so it is idempotent) revokes every live team link, an
 * expired one included, leaves public links and already revoked rows alone,
 * and changes no item's level. The public read path never serves a team link
 * even before the migration ran, and an old team token is still recognised so
 * /s can tell its visitor to sign in as a member.
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/retire-team-links.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const MIGRATION = join(__dirname, '..', '..', 'db', 'migrations', '0176_retire_team_links.sql');

type Row = Record<string, unknown>;

describe.skipIf(!URL)('retire team links (0176 and the share read path)', () => {
  let m: typeof import('@mantle/db');
  let s: typeof import('./shares');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  const owner = randomUUID();
  const tag = `team-links-${owner.slice(0, 8)}`;
  const n = {
    teamNote: randomUUID(), // live team link
    teamPage: randomUUID(), // expired team link, never revoked
    oldTeam: randomUUID(), // team link revoked long ago
    clientNote: randomUUID(), // open link, settings.mode 'public'
    publicPage: randomUUID(), // open link, no mode (pre-mode rows)
    adminNote: randomUUID(), // team link on an item already at admin
  };
  const token = Object.fromEntries(
    Object.keys(n).map((k) => [k, randomBytes(16).toString('base64url')]),
  ) as Record<keyof typeof n, string>;
  const oldRevokedAt = '2026-01-02T03:04:05Z';

  const levels = async () =>
    Object.fromEntries(
      (
        await admin<Row[]>`select id, audience from nodes where owner_id = ${owner} order by id`
      ).map((r) => [r.id, r.audience]),
    );
  const links = async () =>
    Object.fromEntries(
      (
        await admin<Row[]>`select node_id,
                                  (extract(epoch from revoked_at) * 1000)::bigint::text as at
                             from shares where owner_id = ${owner}`
      ).map((r) => [r.node_id, r.at === null ? null : Number(r.at)]),
    );
  /** 0176's statement, as the file has it. */
  const runMigration = async () => {
    const statements = readFileSync(MIGRATION, 'utf8')
      .split('--> statement-breakpoint')
      .filter((stmt) => /^UPDATE /m.test(stmt));
    expect(statements).toHaveLength(1);
    for (const stmt of statements) await admin.unsafe(stmt);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    s = await import('./shares');
    await admin`insert into auth.users (id, email, password_hash, role)
                values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${n.teamNote}, ${owner}, 'note', 'team note', 'notes', 'team'),
      (${n.teamPage}, ${owner}, 'note', 'team page', 'notes', 'team'),
      (${n.oldTeam}, ${owner}, 'note', 'old team', 'notes', 'team'),
      (${n.clientNote}, ${owner}, 'note', 'client note', 'notes', 'client'),
      (${n.publicPage}, ${owner}, 'note', 'public note', 'notes', 'public'),
      (${n.adminNote}, ${owner}, 'note', 'admin note', 'notes', 'admin')`;
    const team = JSON.stringify({ mode: 'team' });
    await admin`insert into shares (owner_id, node_id, node_type, token, settings, expires_at, revoked_at) values
      (${owner}, ${n.teamNote}, 'note', ${token.teamNote}, ${team}::jsonb, null, null),
      (${owner}, ${n.teamPage}, 'note', ${token.teamPage}, ${team}::jsonb, now() - interval '1 day', null),
      (${owner}, ${n.oldTeam}, 'note', ${token.oldTeam}, ${JSON.stringify({ mode: 'team', cascade: true })}::jsonb, null, ${oldRevokedAt}::timestamptz),
      (${owner}, ${n.clientNote}, 'note', ${token.clientNote}, ${JSON.stringify({ mode: 'public' })}::jsonb, null, null),
      (${owner}, ${n.publicPage}, 'note', ${token.publicPage}, '{}'::jsonb, null, null),
      (${owner}, ${n.adminNote}, 'note', ${token.adminNote}, ${team}::jsonb, null, null)`;
  });

  afterAll(async () => {
    await admin`delete from shares where owner_id = ${owner}`;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
  });

  it('never serves or counts a team link, even one the migration has not reached', async () => {
    expect(await s.resolveActiveShareByToken(token.teamNote)).toBeNull();
    expect(await s.getActiveShareForNode(owner, n.teamNote)).toBeNull();
    expect((await s.listActiveShares(owner)).map((l) => l.nodeId).sort()).toEqual(
      [n.clientNote, n.publicPage].sort(),
    );
    expect((await s.resolveActiveShareByToken(token.publicPage))?.nodeId).toBe(n.publicPage);
    expect((await s.resolveActiveShareByToken(token.clientNote))?.nodeId).toBe(n.clientNote);
  });

  it('revokes every live team link, expired ones too, and nothing else; no level changes', async () => {
    const levelsBefore = await levels();
    await runMigration();
    const after = await links();
    expect(after[n.teamNote]).toEqual(expect.any(Number));
    expect(after[n.teamPage]).toEqual(expect.any(Number));
    expect(after[n.adminNote]).toEqual(expect.any(Number));
    expect(after[n.oldTeam]).toBe(Date.parse(oldRevokedAt)); // already revoked: untouched
    expect(after[n.clientNote]).toBeNull();
    expect(after[n.publicPage]).toBeNull();
    expect(await levels()).toEqual(levelsBefore);
    expect(levelsBefore[n.teamNote]).toBe('team');

    // Idempotent: a second run writes nothing.
    await runMigration();
    expect(await links()).toEqual(after);
    expect(await levels()).toEqual(levelsBefore);
  });

  it('still knows an old team token, and only a team one', async () => {
    expect(await s.isRetiredTeamLinkToken(token.teamNote)).toBe(true);
    expect(await s.isRetiredTeamLinkToken(token.oldTeam)).toBe(true);
    expect(await s.isRetiredTeamLinkToken(token.clientNote)).toBe(false);
    expect(await s.isRetiredTeamLinkToken(token.publicPage)).toBe(false);
    expect(await s.isRetiredTeamLinkToken('no-such-token')).toBe(false);
    expect(await s.isRetiredTeamLinkToken('')).toBe(false);
  });

  it('a new link on an item that held a live team link retires the team row first', async () => {
    const node = randomUUID();
    const stale = randomBytes(16).toString('base64url');
    await admin`insert into nodes (id, owner_id, type, title, path, audience)
                values (${node}, ${owner}, 'note', 'stale team', 'notes', 'team')`;
    await admin`insert into shares (owner_id, node_id, node_type, token, settings)
                values (${owner}, ${node}, 'note', ${stale}, ${JSON.stringify({ mode: 'team' })}::jsonb)`;
    const link = await s.createShare(owner, node);
    expect(link.mode).toBe('public');
    expect(link.token).not.toBe(stale);
    const rows = await admin<Row[]>`select token, revoked_at is not null as revoked
                                      from shares where node_id = ${node}`;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.token === stale)!.revoked).toBe(true);
    expect(rows.find((r) => r.token === link.token)!.revoked).toBe(false);
  });
});
