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
 * up by hand; the integrity row workspaces_not_migrated says why). It runs
 * under a 30 s budget (0261, fix round 2 L4: the head wait and every DDL
 * try fit inside it), and ends with the bridge's rows as plain grants and
 * the switch guard's proof (0261). A timeout (55P03) or a refused proof
 * (23514) rolls the whole transaction back: the brain stays on the old
 * model, the integrity row stays, and the next start tries again. Then mantle_ws_attach_assistants puts the default assistants on
 * Admin and Team once onboarding has made them. Nothing repairs grants at
 * boot: an item left without a home (one made in another transaction while
 * the migration ran) is counted by `pnpm workspaces:check`. No LLM work, no
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
    console.warn(
      `[workspaces] ${when}: a lock stayed busy past the time budget; nothing changed, tries again at the next boot`,
    );
    return;
  }
  if (code === '23514') {
    console.error(
      `[workspaces] ${when}: the switch guard refused the switch, nothing changed (the brain stays on levels):`,
      err instanceof Error ? err.message : err,
    );
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
