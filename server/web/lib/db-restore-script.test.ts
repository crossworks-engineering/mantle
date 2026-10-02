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

  it('checks every trigger the dump lists, and a missing one fails the restore (restore rehearsal 2026-10-01)', () => {
    // The names come from the dump's own table of contents, not a list kept
    // here: a trigger a later migration adds is checked with no edit.
    expect(script).toMatch(/pg_restore --list < "\$DUMP"/);
    expect(script).toContain(`awk '$4 == "TRIGGER" { print $5 "." $6 "." $7 }'`);
    expect(script).toMatch(/FROM pg_trigger t[\s\S]*?WHERE NOT t\.tgisinternal/);
    const check = script.indexOf('fail "the trigger ${t##*.} on ${t%.*} is missing"');
    expect(check).toBeGreaterThan(script.indexOf('pg_restore -U postgres -d postgres'));
    expect(check).toBeLessThan(script.search(/Restore FAILED[\s\S]*?exit 2/));
    // A dump that cannot be listed is not passed as checked.
    expect(script).toMatch(/fail "could not read the dump's table of contents/);
  });

  it('makes the one trigger a dump from before 0212 cannot carry, exactly as 0212 makes it', () => {
    const tag = journal.entries.find((e) => e.tag.startsWith('0212'))!.tag;
    const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    const made = read(`packages/db/migrations/${tag}.sql`)
      .split('--> statement-breakpoint')
      .map((stmt) => stmt.trim())
      .find((stmt) => stmt.startsWith('CREATE TRIGGER "nodes_share_refresh_after"'));
    expect(made, `${tag} no longer makes the trigger`).toBeTruthy();
    const inScript = script.match(
      /<<'SQL'\n(CREATE TRIGGER "nodes_share_refresh_after"[\s\S]*?)\nSQL\n/,
    );
    expect(inScript, 'the trigger statement is gone from db-restore.sh').toBeTruthy();
    expect(squash(inScript![1]!)).toBe(squash(made!));
    // The text form of the path: the form a later dump can carry.
    expect(made).toMatch(/OLD\."path"::text IS DISTINCT FROM NEW\."path"::text/);
    // Only for a dump from 0204 up to 0210 (it cannot carry the trigger, and
    // 0204 made the function), and before the check, so a dump from 0212 on
    // that lacks the trigger still fails.
    const repair = script.indexOf(
      'if [ "$LEDGER" -ge "$WHEN_0204" ] && [ "$LEDGER" -lt "$WHEN_0212" ]',
    );
    expect(repair).toBeGreaterThan(0);
    expect(script.slice(repair, repair + 200)).toContain('! has_trigger "$SHARE_REFRESH"; then');
    // A create that fails is printed, and the check below then fails the
    // restore: from 0204 on the trigger must be there, listed or not.
    const create = script.indexOf('-c "$SHARE_REFRESH_TRIGGER" 2>&1); then');
    expect(create).toBeGreaterThan(repair);
    expect(script).toContain('could not make the trigger nodes_share_refresh_after');
    const required = script.indexOf(
      'if [ "$LEDGER" -ge "$WHEN_0204" ] && ! has_trigger "$SHARE_REFRESH"; then\n  fail "the trigger nodes_share_refresh_after on public.nodes is missing',
    );
    expect(required).toBeGreaterThan(create);
    expect(required).toBeLessThan(script.search(/Restore FAILED[\s\S]*?exit 2/));
    expect(repair).toBeLessThan(script.indexOf('fail "the trigger ${t##*.}'));
    // The names are read line by line and compared whole, never as patterns.
    expect(script).toMatch(
      /while IFS= read -r t; do[\s\S]*?done <<EOF_TRIGGERS\n\$DUMP_TRIGGERS\nEOF_TRIGGERS/,
    );
    expect(script).not.toMatch(/for t in \$DUMP_TRIGGERS/);
    expect(read('packages/db/migrations/0204_folder_sharing.sql')).toContain(
      'CREATE OR REPLACE FUNCTION "public"."mantle_nodes_refresh_trg"()',
    );
  });

  it('never says "Restore complete" over a pg_restore error it cannot explain, and exits 3 after its last step', () => {
    // The old line that hid the lost trigger is gone.
    expect(script).not.toMatch(/Restore complete, WITH/);
    // Counted: every error line, less the one a dump from before 0212 always
    // gives, and only when the script made that trigger again.
    expect(script).toContain('UNEXPLAINED=$((RESTORE_ERRORS - EXPLAINED_ERRORS))');
    const explained = script.indexOf(
      "EXPLAINED_ERRORS=$(grep -c '^Command was: CREATE TRIGGER nodes_share_refresh_after '",
    );
    expect(explained).toBeGreaterThan(script.indexOf('-c "$SHARE_REFRESH_TRIGGER" 2>&1); then'));
    // A non-zero exit with no error line counts too.
    expect(script).toMatch(
      /\[ "\$RESTORE_ERRORS" -eq 0 \] && \[ "\$RESTORE_RC" -ne 0 \]; then\n\s+UNEXPLAINED=1/,
    );
    // "Restore complete" is only in the branches with nothing unexplained.
    const verdict = script.indexOf('if [ "$UNEXPLAINED" -gt 0 ]; then');
    const complete = script.indexOf('✔ Restore complete');
    expect(verdict).toBeGreaterThan(script.search(/Restore FAILED[\s\S]*?exit 2/));
    expect(complete).toBeGreaterThan(verdict);
    expect(script.slice(verdict, complete)).not.toContain('✔');
    // The exit comes after the client sign-in and personal-space steps, so
    // those still run on a brain that passed its checks.
    // The full pg_restore output is kept when the script ends 2 or 3.
    expect(script).toContain(`trap '[ -n "$KEEP_LOG" ] || rm -f "$RESTORE_LOG"' EXIT`);
    expect(
      script.match(
        /KEEP_LOG=1\n\s+echo " {2}The full pg_restore output is kept in \$RESTORE_LOG" >&2\n\s+exit [23]\n/g,
      ),
      // A failed check (2), a --new-brain that could not re-id (2), an
      // unexplained pg_restore error (3).
    ).toHaveLength(3);
    const exit3 = script.search(
      /if \[ "\$UNEXPLAINED" -gt 0 \]; then\n(?:\s+(?:echo .*|KEEP_LOG=1)\n)+\s+exit 3\n/,
    );
    expect(exit3).toBeGreaterThan(script.indexOf('Restored personal-space files'));
    expect(exit3).toBeGreaterThan(script.indexOf('UPDATE public.client_signin_codes'));
    expect(exit3).toBeLessThan(script.indexOf('Next:  docker compose up -d --wait'));
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

  it('keeps the brain id on a plain restore, and gives a new brain its own only with --new-brain', () => {
    // The flag is parsed, and the dump is still the one positional argument.
    expect(script).toMatch(/--new-brain\) NEW_BRAIN=1 ;;/);
    expect(script).not.toMatch(/DUMP="\$\{1:\?/);
    // The only write to brain_identity sits inside the --new-brain branch.
    const writes = [...script.matchAll(/UPDATE public\.brain_identity/g)];
    expect(writes).toHaveLength(1);
    const branch = script.indexOf('if [ "$NEW_BRAIN" = 1 ]; then');
    const plain = script.indexOf('elif [ -n "$DUMP_BRAIN_ID" ]; then', branch);
    expect(branch).toBeGreaterThan(0);
    expect(writes[0]!.index).toBeGreaterThan(branch);
    expect(writes[0]!.index).toBeLessThan(plain);
    // A plain restore says which id it kept and how to give a copy its own.
    expect(script.slice(plain)).toMatch(/kept: this is the same brain/);
    // Gated on the table, not the ledger: an older dump has none, and the
    // next migrate makes a fresh one.
    expect(script).toMatch(/to_regclass\('public\.brain_identity'\)/);
    // After the checks: a restore that failed them never re-ids anything.
    expect(branch).toBeGreaterThan(script.search(/Restore FAILED[\s\S]*?exit 2/));
  });
});
