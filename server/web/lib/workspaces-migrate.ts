/**
 * Bring a brain onto workspaces when it has none yet (workspaces W5b1 fix
 * rounds 1 and 2, audit M1, M-new, L-a, L-b). Migration 0252 migrates the
 * brain that exists when the migrations run; a fresh install has no owner
 * then, so it is migrated here: once its first owner exists, and as a boot
 * step for a brain that missed it.
 *
 * mantle_ws_migrate_locked (0257, 0259) does the work in one transaction and
 * skips, without a lock, a brain already migrated, one with no owner, and one
 * with client logins or client-level items (owner rule 21.9: clients are set
 * up by hand; the integrity row workspaces_not_migrated says why). It waits
 * at most 10 s for a lock. Then mantle_ws_repair_drift gives grants to any
 * item made while it ran, and mantle_ws_attach_assistants puts the default
 * assistants on Admin and Team once onboarding has made them. No LLM work,
 * no extractor notify.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

export type WsMigrateRow = { section: string; subject: string; metric: string; n: number };

/** Migrate this brain if it has no workspaces and nothing stops it, then
 *  repair the bridge drift of anything made meanwhile (its own transaction,
 *  after the migration committed). */
export async function migrateWorkspaces(): Promise<WsMigrateRow[]> {
  const rows = (await db.execute(
    sql`select * from "public"."mantle_ws_migrate_locked"()`,
  )) as unknown as WsMigrateRow[];
  await repairWorkspaceDrift();
  return rows.map((r) => ({ ...r, n: Number(r.n) }));
}

/** Give the bridge's grants to items that lack them (heads first). Returns
 *  how many items it repaired; 0 when there is no drift. */
export async function repairWorkspaceDrift(): Promise<number> {
  const [r] = (await db.execute(
    sql`select "public"."mantle_ws_repair_drift"() as n`,
  )) as unknown as {
    n: number;
  }[];
  return Number(r?.n ?? 0);
}

/** Attach the default assistants where Admin or Team has none yet. Returns
 *  how many it attached. */
export async function attachDefaultAssistants(): Promise<number> {
  const [r] = (await db.execute(
    sql`select "public"."mantle_ws_attach_assistants"() as n`,
  )) as unknown as { n: number }[];
  return Number(r?.n ?? 0);
}

function failure(when: string, err: unknown): void {
  const code =
    (err as { code?: string; cause?: { code?: string } })?.cause?.code ??
    (err as { code?: string })?.code;
  if (code === '55P03') {
    console.warn(`[workspaces] ${when}: a lock was busy; tries again at the next boot`);
    return;
  }
  console.error(`[workspaces] ${when}: failed:`, err instanceof Error ? err.message : err);
}

/** Best effort: log what happened, never throw (signup and boot go on; the
 *  next boot tries again, and the integrity rows show what is left). */
export async function migrateWorkspacesQuietly(when: string): Promise<void> {
  try {
    const rows = await migrateWorkspaces();
    const skip = rows.find((r) => r.section === 'skip');
    if (skip && skip.metric !== 'already migrated') {
      console.warn(`[workspaces] ${when}: not migrated (${skip.subject})`);
      return;
    }
    if (!skip) console.log(`[workspaces] ${when}: migrated onto workspaces`);
    const attached = await attachDefaultAssistants();
    if (attached) console.log(`[workspaces] ${when}: attached ${attached} default assistant(s)`);
  } catch (err) {
    failure(when, err);
  }
}

/** Onboarding, after the manifest seed made the assistants. Never throws. */
export async function attachDefaultAssistantsQuietly(when: string): Promise<void> {
  try {
    const attached = await attachDefaultAssistants();
    if (attached) console.log(`[workspaces] ${when}: attached ${attached} default assistant(s)`);
  } catch (err) {
    failure(when, err);
  }
}
