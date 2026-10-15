/**
 * Which migrations a run applies, and what it refuses (arch A6 fix round 1,
 * H1). The ledger keeps one row per applied migration: its hash and its
 * journal `when` (created_at). A run applies every journal entry whose
 * `when` is above the highest one applied (the high-water mark), in order,
 * as drizzle's migrator always did.
 *
 * An entry at or below the mark that the ledger does not hold (by its
 * `when` or by its hash) was never applied, and gating on the mark alone
 * would skip it on this database for ever, silently: a lower number that
 * landed after a higher one (two branches claiming 0290 and 0291, merged in
 * the wrong order), or a `when` stamped below its predecessor. Such a gap
 * is
 *
 *  - refused, from GAP_REFUSED_FROM on (0290): the run applies nothing and
 *    fails, naming each missing migration, so an operator sees it before
 *    any later one runs over a schema that lacks it;
 *  - a loud warning below it: some boxes carry historic gaps (an entry
 *    re-stamped or edited in place long ago, 0211 never filled), and those
 *    must not stop a roll.
 *
 * Pure: the database part is migrate-runner.ts.
 */

/** The first migration number whose gap refuses the run. */
export const GAP_REFUSED_FROM = 290;

/** A journal entry (migrations/meta/_journal.json). */
export type JournalEntry = { idx: number; tag: string; when: number };

/** A migration as drizzle's readMigrationFiles returns it (the parts read). */
export type PlannedMigration = { folderMillis: number; hash: string };

/** A ledger row (drizzle.__drizzle_migrations). */
export type LedgerRow = { hash: string; created_at: string | number | null };

/** A journal entry below the high-water mark that was never applied. */
export type MigrationGap = {
  idx: number;
  tag: string;
  when: number;
  hash: string;
  refused: boolean;
};

export type MigrationPlan<M extends PlannedMigration> = {
  /** The high-water mark (-1 on an empty ledger). */
  lastWhen: number;
  /** What the run applies, in order. */
  pending: M[];
  /** Never applied, below the mark: refused ones and warnings. */
  gaps: MigrationGap[];
};

export function planMigrations<M extends PlannedMigration>(
  migrations: readonly M[],
  journal: readonly JournalEntry[],
  ledger: readonly LedgerRow[],
): MigrationPlan<M> {
  const appliedWhen = new Set<number>();
  const appliedHash = new Set<string>();
  let lastWhen = -1;
  for (const row of ledger) {
    appliedHash.add(row.hash);
    if (row.created_at == null) continue;
    const when = Number(row.created_at);
    appliedWhen.add(when);
    if (when > lastWhen) lastWhen = when;
  }
  const byWhen = new Map(journal.map((e) => [e.when, e] as const));
  const pending: M[] = [];
  const gaps: MigrationGap[] = [];
  for (const m of migrations) {
    if (m.folderMillis > lastWhen) {
      pending.push(m);
      continue;
    }
    if (appliedWhen.has(m.folderMillis) || appliedHash.has(m.hash)) continue;
    const e = byWhen.get(m.folderMillis);
    const idx = e?.idx ?? -1;
    gaps.push({
      idx,
      tag: e?.tag ?? `when ${m.folderMillis}`,
      when: m.folderMillis,
      hash: m.hash,
      // An entry the journal does not name is refused too: nothing says it
      // is historic.
      refused: idx < 0 || idx >= GAP_REFUSED_FROM,
    });
  }
  return { lastWhen, pending, gaps };
}

/** The refusal's text: each missing migration, and what to do. */
export function gapRefusal(gaps: readonly MigrationGap[]): string {
  const refused = gaps.filter((g) => g.refused);
  return (
    `migrate: refused. ${refused.length} migration(s) were never applied here but sit at or ` +
    `below the highest one applied, so the runner would skip them for ever: ` +
    refused.map((g) => `${g.tag} (when ${g.when})`).join(', ') +
    `. Nothing was applied. A lower-numbered migration landed after a higher one ` +
    `(merge order) or its journal when is stamped too low. Apply it by hand in a ` +
    `transaction (as system:migration) and record it in drizzle.__drizzle_migrations ` +
    `with its hash and when, or restamp it above the mark in a new release; then run again.`
  );
}

/** The warning's text for a historic gap (below GAP_REFUSED_FROM). */
export function gapWarning(g: MigrationGap): string {
  return (
    `  WARNING migration ${g.tag} (when ${g.when}) was never applied here and sits below ` +
    `the highest one applied: skipped (a historic gap, below ${String(GAP_REFUSED_FROM).padStart(4, '0')}; ` +
    `the run goes on). Check this database's schema for it.`
  );
}
