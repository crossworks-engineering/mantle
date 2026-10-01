import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * scripts/db-restore.sh judges a restored brain by the dump's own migration
 * ledger: a check applies once the migration that made its object has run.
 * The script names those migrations by their journal `when`, as numbers a
 * shell can compare. This keeps the numbers and the object names in step
 * with the migrations. The restore itself is proven against a real Postgres
 * (client logins audit A1: a restore into an init-made database dropped every
 * login and still said "Restore complete").
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const script = read('scripts/db-restore.sh');
const journal = JSON.parse(read('packages/db/migrations/meta/_journal.json')) as {
  entries: Array<{ tag: string; when: number }>;
};

describe('db-restore.sh', () => {
  it('names each migration by its real journal when', () => {
    const consts = [...script.matchAll(/^WHEN_(\d{4})=(\d+)\s+# (\S+):/gm)];
    expect(consts.length).toBeGreaterThanOrEqual(3);
    for (const [, n, when, tag] of consts) {
      const entry = journal.entries.find((e) => e.tag === tag);
      expect(entry, `${tag} not in the journal`).toBeTruthy();
      expect(tag!.slice(0, 4)).toBe(n);
      expect(Number(when)).toBe(entry!.when);
    }
  });

  it('checks every object the audit named, and each is made by the migration it is gated on', () => {
    const gated: Record<string, { gate: string; made: RegExp }> = {
      nodes_viewer_read: { gate: '0159', made: /CREATE POLICY "?nodes_viewer_read"?/ },
      users_role_ck: { gate: '0162', made: /ADD CONSTRAINT "?users_role_ck"?/ },
      agents_viewer_read: { gate: '0187', made: /CREATE POLICY "?agents_viewer_read"?/ },
      agents_client_read: { gate: '0187', made: /CREATE POLICY "?agents_client_read"?/ },
      tool_groups_viewer_read: { gate: '0187', made: /CREATE POLICY "?tool_groups_viewer_read"?/ },
      tool_groups_client_read: { gate: '0187', made: /CREATE POLICY "?tool_groups_client_read"?/ },
    };
    for (const [name, { gate, made }] of Object.entries(gated)) {
      expect(script, `${name} not checked`).toContain(name);
      const tag = journal.entries.find((e) => e.tag.startsWith(gate))!.tag;
      expect(read(`packages/db/migrations/${tag}.sql`), `${name} not made by ${tag}`).toMatch(made);
    }
    expect(script).toMatch(/SELECT count\(\*\) FROM auth\.users/);
  });

  it('revokes open client sign-in links and codes and lists the client logins, once the dump has 0188 (audit B22)', () => {
    // Gated on the dump's own ledger: an older dump has no such table.
    const gate = script.indexOf('if [ "$LEDGER" -ge "$WHEN_0188" ]; then');
    expect(gate).toBeGreaterThan(0);
    const block = script.slice(gate, script.indexOf('\nfi\n', gate));
    // Every open code, links and emailed codes alike (no kind filter).
    expect(block).toMatch(
      /UPDATE public\.client_signin_codes SET revoked_at = now\(\)\s+WHERE used_at IS NULL AND revoked_at IS NULL/,
    );
    expect(block).not.toMatch(/kind\s*=/);
    expect(block).toMatch(/FROM auth\.users WHERE role = 'client' ORDER BY email/);
    // After the restore has passed its checks (never on a failed restore).
    expect(gate).toBeGreaterThan(script.search(/Restore FAILED[\s\S]*?exit 2/));
    // The table and the columns it touches are the ones 0188 made.
    const tag = journal.entries.find((e) => e.tag.startsWith('0188'))!.tag;
    const sql = read(`packages/db/migrations/${tag}.sql`);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "public"\."client_signin_codes"/);
    for (const col of ['used_at', 'revoked_at']) expect(sql).toContain(`"${col}"`);
  });

  it('restores into a pristine database, and a failed check exits non-zero before "Restore complete"', () => {
    const drop = script.indexOf('DROP DATABASE IF EXISTS postgres WITH (FORCE)');
    const create = script.indexOf('CREATE DATABASE postgres');
    const restore = script.indexOf('pg_restore -U postgres -d postgres');
    const failExit = script.search(/Restore FAILED[\s\S]*?exit 2/);
    const complete = script.indexOf('✔ Restore complete');
    expect(drop).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(drop);
    expect(restore).toBeGreaterThan(create);
    expect(failExit).toBeGreaterThan(restore);
    expect(complete).toBeGreaterThan(failExit);
    // The guard counts logins as data: the script drops the database.
    expect(script).toMatch(/SELECT count\(\*\) FROM auth\.users\) > 0/);
  });
});
