/**
 * Bring a brain onto workspaces when it has none yet (workspaces W5b1 fix
 * round 1, audit M1). Migration 0252 migrates the brain that exists when the
 * migrations run; a fresh install has no owner then, so it is migrated here:
 * once its first owner exists, and as a boot step for a brain that missed it.
 *
 * mantle_ws_migrate_locked (0257) does the work in one transaction and skips,
 * without a lock, a brain already migrated, one with no owner, and one with
 * client logins or client-level items (owner rule 21.9: clients are set up by
 * hand; the integrity row workspaces_not_migrated says why). No LLM work, no
 * extractor notify.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

export type WsMigrateRow = { section: string; subject: string; metric: string; n: number };

/** Migrate this brain if it has no workspaces and nothing stops it. */
export async function migrateWorkspaces(): Promise<WsMigrateRow[]> {
  const rows = (await db.execute(
    sql`select * from "public"."mantle_ws_migrate_locked"()`,
  )) as unknown as WsMigrateRow[];
  return rows.map((r) => ({ ...r, n: Number(r.n) }));
}

/** Best effort: log what happened, never throw (signup and boot go on; the
 *  next boot tries again, and the integrity row shows a brain left out). */
export async function migrateWorkspacesQuietly(when: string): Promise<void> {
  try {
    const rows = await migrateWorkspaces();
    const skip = rows.find((r) => r.section === 'skip');
    if (skip?.metric === 'already migrated') return;
    if (skip) console.warn(`[workspaces] ${when}: not migrated (${skip.subject})`);
    else console.log(`[workspaces] ${when}: migrated onto workspaces`);
  } catch (err) {
    console.error(
      `[workspaces] ${when}: migration failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
