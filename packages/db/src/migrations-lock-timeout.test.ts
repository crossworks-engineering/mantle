import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A migration that locks a hot table must say how long it will wait for the
 * lock. Without `SET LOCAL lock_timeout`, an ALTER, a trigger or a policy on
 * nodes waits behind a long reader for as long as it takes, and every other
 * query on the table queues behind the ALTER: the box looks down for the
 * whole wait. With it, the migration fails after 30 s and the roll stops
 * (0165, 0166, 0180 and 0183 do this). The client logins audit (A26) found
 * 0186 and 0187 without it.
 *
 * Checked from 0186 on: the older ones have run on every box already, so
 * editing them changes nothing.
 */
const FIRST_CHECKED = 186;
const HOT = String.raw`(?:"?public"?\.)?"?(?:nodes|agents|tool_groups|space_items)"?|"?auth"?\."?users"?`;
const LOCKS_HOT = new RegExp(
  [
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:${HOT})\s`,
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s[\s\S]*?\bON\s+(?:${HOT})\s`,
    String.raw`(?:CREATE|DROP|ALTER)\s+POLICY\s[\s\S]*?\bON\s+(?:${HOT})\s`,
    String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)[\s\S]*?\bON\s+(?:${HOT})[\s(]`,
  ].join('|'),
  'i',
);

/** The statements of a migration, comments stripped, in order. */
function statementsOf(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((s) =>
      s
        .split('\n')
        .map((l) => l.replace(/--.*$/, ''))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

/** True when the migration locks a hot table and its first statement is not
 *  `SET LOCAL lock_timeout`. */
function missesLockTimeout(sql: string): boolean {
  const stmts = statementsOf(sql);
  if (!stmts.some((s) => LOCKS_HOT.test(`${s}\n`))) return false;
  return !/^SET\s+LOCAL\s+lock_timeout\s*=/i.test(stmts[0] ?? '');
}

describe('migrations that lock a hot table set lock_timeout first', () => {
  const dir = join(__dirname, '..', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) >= FIRST_CHECKED)
    .sort();

  it('finds the migrations it checks', () => {
    expect(files).toContain('0186_needs_you_notify.sql');
    expect(files).toContain('0187_client_level.sql');
  });

  it('every checked migration that locks nodes, agents, tool_groups, space_items or auth.users starts with it', () => {
    const missing = files.filter((f) => missesLockTimeout(readFileSync(join(dir, f), 'utf8')));
    expect(
      missing,
      `start these with "SET LOCAL lock_timeout = '30s';" and a statement breakpoint (see 0165)`,
    ).toEqual([]);
  });

  it('the detector sees the locks it is meant to see', () => {
    const bare = `ALTER TABLE "auth"."users" ADD CONSTRAINT x CHECK (true);`;
    expect(missesLockTimeout(bare)).toBe(true);
    expect(missesLockTimeout(`CREATE POLICY "p" ON "public"."agents" FOR SELECT USING (true);`)).toBe(
      true,
    );
    expect(
      missesLockTimeout(
        `CREATE TRIGGER t AFTER INSERT ON "public"."space_items" FOR EACH ROW EXECUTE FUNCTION f();`,
      ),
    ).toBe(true);
    expect(
      missesLockTimeout(
        `-- a comment\nSET LOCAL lock_timeout = '30s';\n--> statement-breakpoint\n${bare}`,
      ),
    ).toBe(false);
    // A new table that only references a hot one is not checked (0188).
    expect(
      missesLockTimeout(
        `CREATE TABLE IF NOT EXISTS "public"."x" ("u" uuid REFERENCES "auth"."users"("id"));`,
      ),
    ).toBe(false);
    // Nor an index built without blocking writes.
    expect(
      missesLockTimeout(`CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON "public"."nodes" (id);`),
    ).toBe(false);
  });
});
