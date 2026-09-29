/**
 * Client logins C3 on a real, migrated Postgres: the old client links
 * retire. Migration 0192 (re-run here on seeded rows; it is idempotent)
 * revokes every live link on a client item, an expired one included, marks
 * each `retired: 'client'` (a link revoked earlier without the mark too,
 * keeping its revoked_at), and leaves links on items at other levels and
 * every item's level alone. The public read path never serves a link on a
 * client item, even one the migration has not reached; an old client token
 * is recognised so /s can say "sign in as a client"; Shared links lists the
 * retired ones without a token.
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/retire-client-links.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const MIGRATION = join(__dirname, '..', '..', 'db', 'migrations', '0192_retire_client_links.sql');

type Row = Record<string, unknown>;

describe.skipIf(!URL)('retire client links (0192 and the share read path)', () => {
  let m: typeof import('@mantle/db');
  let s: typeof import('./shares');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  const owner = randomUUID();
  const tag = `client-links-${owner.slice(0, 8)}`;
  const n = {
    clientNote: randomUUID(), // live link on a client item
    clientPage: randomUUID(), // expired link, never revoked, client item
    oldClient: randomUUID(), // client item, link revoked earlier WITHOUT the mark
    markedClient: randomUUID(), // client item, link already revoked and marked
    publicNote: randomUUID(), // live link on a public item
    adminNote: randomUUID(), // live link on an admin item (a leftover)
  };
  const token = Object.fromEntries(
    Object.keys(n).map((k) => [k, randomBytes(16).toString('base64url')]),
  ) as Record<keyof typeof n, string>;
  const oldRevokedAt = '2026-01-02T03:04:05Z';

  const links = async () =>
    Object.fromEntries(
      (
        await admin<Row[]>`select node_id, settings->>'retired' as retired,
                                  (extract(epoch from revoked_at) * 1000)::bigint::text as at
                             from shares where owner_id = ${owner}`
      ).map((r) => [r.node_id, { retired: r.retired, at: r.at === null ? null : Number(r.at) }]),
    );
  const levels = async () =>
    Object.fromEntries(
      (await admin<Row[]>`select id, audience from nodes where owner_id = ${owner}`).map((r) => [
        r.id,
        r.audience,
      ]),
    );
  /** 0192's UPDATE, as the file has it. */
  const runMigration = async () => {
    const statements = readFileSync(MIGRATION, 'utf8')
      .split('--> statement-breakpoint')
      .filter((stmt) => /^UPDATE /m.test(stmt));
    expect(statements).toHaveLength(1);
    // Scoped to this file's owner: other test files share the database.
    const scoped = `${statements[0]!.trim().replace(/;$/, '')} AND s."owner_id" = '${owner}'`;
    await admin.unsafe(scoped);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    s = await import('./shares');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role)
                values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    const level: Record<keyof typeof n, string> = {
      clientNote: 'client',
      clientPage: 'client',
      oldClient: 'client',
      markedClient: 'client',
      publicNote: 'public',
      adminNote: 'admin',
    };
    for (const k of Object.keys(n) as (keyof typeof n)[]) {
      await admin`insert into nodes (id, owner_id, type, title, path, audience, data)
                  values (${n[k]}, ${owner}, 'note', ${`${tag} ${k}`}, 'notes', ${level[k]}, '{}'::jsonb)`;
    }
    const link = (
      k: keyof typeof n,
      extra: { expires?: string; revoked?: string; retired?: boolean },
    ) =>
      admin`insert into shares (owner_id, node_id, node_type, token, expires_at, revoked_at, settings, view_count)
            values (${owner}, ${n[k]}, 'note', ${token[k]}, ${extra.expires ?? null}, ${extra.revoked ?? null},
                    ${JSON.stringify(extra.retired ? { retired: 'client' } : {})}::jsonb, 7)`;
    await link('clientNote', {});
    await link('clientPage', { expires: '2026-01-01T00:00:00Z' });
    await link('oldClient', { revoked: oldRevokedAt });
    await link('markedClient', { revoked: oldRevokedAt, retired: true });
    await link('publicNote', {});
    await link('adminNote', {});
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from shares where owner_id = ${owner}`;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
  });

  it('never serves a live link on a client item, even before the migration', async () => {
    expect(await s.resolveActiveShareByToken(token.clientNote)).toBeNull();
    expect((await s.resolveActiveShareByToken(token.publicNote))?.nodeId).toBe(n.publicNote);
    // Such a token is already an old client link to /s.
    expect(await s.isRetiredClientLinkToken(token.clientNote)).toBe(true);
  });

  it('revokes and marks every client link, and nothing else', async () => {
    const before = Date.now();
    await runMigration();
    const after = await links();
    for (const k of ['clientNote', 'clientPage'] as const) {
      expect(after[n[k]]!.retired, k).toBe('client');
      expect(after[n[k]]!.at, k).toBeGreaterThanOrEqual(before - 5000);
    }
    // Revoked earlier: marked now, its revoked_at kept.
    expect(after[n.oldClient]).toEqual({ retired: 'client', at: Date.parse(oldRevokedAt) });
    expect(after[n.markedClient]).toEqual({ retired: 'client', at: Date.parse(oldRevokedAt) });
    // Other levels untouched.
    expect(after[n.publicNote]).toEqual({ retired: null, at: null });
    expect(after[n.adminNote]).toEqual({ retired: null, at: null });
  });

  it('keeps every item level', async () => {
    expect(await levels()).toEqual({
      [n.clientNote]: 'client',
      [n.clientPage]: 'client',
      [n.oldClient]: 'client',
      [n.markedClient]: 'client',
      [n.publicNote]: 'public',
      [n.adminNote]: 'admin',
    });
  });

  it('is idempotent: a second run writes nothing', async () => {
    const first = await links();
    await runMigration();
    expect(await links()).toEqual(first);
  });

  it('recognises old client tokens, and no other', async () => {
    for (const k of ['clientNote', 'clientPage', 'oldClient', 'markedClient'] as const) {
      expect(await s.isRetiredClientLinkToken(token[k]), k).toBe(true);
    }
    expect(await s.isRetiredClientLinkToken(token.publicNote)).toBe(false);
    expect(await s.isRetiredClientLinkToken(token.adminNote)).toBe(false);
    expect(await s.isRetiredClientLinkToken('no-such-token')).toBe(false);
    expect(await s.isRetiredClientLinkToken('')).toBe(false);
  });

  it('a public item raised to client later: its link stops, and reads as an old client link', async () => {
    await admin`update nodes set audience = 'client' where id = ${n.publicNote}`;
    try {
      expect(await s.resolveActiveShareByToken(token.publicNote)).toBeNull();
      expect(await s.isRetiredClientLinkToken(token.publicNote)).toBe(true);
    } finally {
      await admin`update nodes set audience = 'public' where id = ${n.publicNote}`;
    }
    expect((await s.resolveActiveShareByToken(token.publicNote))?.nodeId).toBe(n.publicNote);
  });

  it('lists the retired links for Shared links, without a token', async () => {
    const rows = await s.listRetiredClientLinks(owner);
    expect(rows.map((r) => r.nodeId).sort()).toEqual(
      [n.clientNote, n.clientPage, n.oldClient, n.markedClient].sort(),
    );
    const one = rows.find((r) => r.nodeId === n.oldClient)!;
    expect(one).toMatchObject({
      title: `${tag} oldClient`,
      level: 'client',
      viewCount: 7,
      retiredAt: new Date(oldRevokedAt).toISOString(),
    });
    expect(JSON.stringify(rows)).not.toContain(token.oldClient);
  });
});
