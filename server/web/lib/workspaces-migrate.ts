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
 * up by hand; the integrity row workspaces_not_migrated says why). Its head
 * wait takes at most 10 s, and the switch itself (the DDL) runs under a
 * time budget that starts at the switch (0263: 30 s, or
 * mantle.ws_switch_budget for a manual run, 1 s to 1 h). It ends with the
 * bridge's rows as plain grants, the switch guard's proof (0261) and the
 * review homes (0264). A timeout (55P03) or a refused proof (23514) rolls
 * the whole transaction back: the brain stays on the old model, the
 * integrity row stays, and the next start tries again. Then
 * mantle_ws_attach_assistants puts the default assistants on
 * Admin and Team once onboarding has made them. Nothing repairs grants at
 * boot: an item left without a home (one made in another transaction while
 * the migration ran) is counted by `pnpm workspaces:check`. No LLM work, no
 * extractor notify.
 *
 * Since arch A7 the code has no rule for a brain off workspaces (no
 * rollback switch, no level path): the web boot refuses one
 * (unmigratedBrainReason, server/main.ts). A box that reports "clients
 * present" is switched by hand, as the operator notes say
 * (docs/workspaces.md: mantle_ws_migrate_locked with
 * mantle.ws_former_clients = 'reviewed'), then started again.
 */
import { sql } from 'drizzle-orm';
import { db, executeAsMigrator, loginScopeFor } from '@mantle/db';
import { UUID_RE } from '@mantle/std';

export type WsMigrateRow = { section: string; subject: string; metric: string; n: number };

/** Migrate this brain if it has no workspaces and nothing stops it. The
 *  switch runs DDL, which the runtime role may not (arch A9): on the
 *  migrator's connection (executeAsMigrator). */
export async function migrateWorkspaces(): Promise<WsMigrateRow[]> {
  const rows = await executeAsMigrator<WsMigrateRow>(
    sql`select * from "public"."mantle_ws_migrate_locked"()`,
  );
  return rows.map((r) => ({ ...r, n: Number(r.n) }));
}

/** Attach the default assistants where Admin or Team has none yet. Returns
 *  how many it attached. A definer (0305): with no
 *  `loginId` it is system work (the boot, systemWork in server/main.ts);
 *  with one it runs in that login's own scope on the system pool (its
 *  workspaces and its login set, as systemPoolTx sets a write scope), where
 *  the definer asks the assistants area of it: the first owner at signup
 *  and onboarding, both inside a request. */
export async function attachDefaultAssistants(loginId?: string): Promise<number> {
  const call = sql`select "public"."mantle_ws_attach_assistants"() as n`;
  if (loginId === undefined) {
    const [r] = (await db.execute(call)) as unknown as { n: number }[];
    return Number(r?.n ?? 0);
  }
  const scope = await loginScopeFor(loginId);
  const ids = (xs: readonly string[]) => {
    if (!xs.every((x) => UUID_RE.test(x))) throw new Error('attach: a workspace id');
    return `{${xs.join(',')}}`;
  };
  const rows = (await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('mantle.ws', ${ids(scope.ws)}, true),
                 set_config('mantle.mod_ws', ${ids(scope.modWs)}, true),
                 set_config('mantle.scope_login', ${loginId}::uuid::text, true)`,
    );
    return tx.execute(call);
  })) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

function failure(when: string, err: unknown): void {
  const code =
    (err as { code?: string; cause?: { code?: string } })?.cause?.code ??
    (err as { code?: string })?.code;
  if (code === '55P03') {
    console.warn(
      `[workspaces] ${when}: the switch ran past its time budget; nothing changed, tries again at the next boot (a manual run may give more time: SET mantle.ws_switch_budget)`,
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
export async function migrateWorkspacesQuietly(when: string, loginId?: string): Promise<void> {
  try {
    const rows = await migrateWorkspaces();
    const skip = rows.find((r) => r.section === 'skip');
    if (skip && skip.metric !== 'already migrated') {
      console.warn(`[workspaces] ${when}: not migrated (${skip.subject})`);
      return;
    }
    if (!skip) console.log(`[workspaces] ${when}: migrated onto workspaces`);
    const attached = await attachDefaultAssistants(loginId);
    if (attached) console.log(`[workspaces] ${when}: attached ${attached} default assistant(s)`);
  } catch (err) {
    failure(when, err);
  }
}

/**
 * Why this brain may not serve (arch A7), or null when it may: on
 * workspaces, or a fresh install with no owner yet (it serves the signup,
 * and its first owner switches it, lib/auth/first-owner.ts). Otherwise the
 * reason mantle_ws_skip_reason gives ("clients present: ...", or "no
 * workspaces yet" when the boot switch failed). Asked after the boot
 * switch. Throws when the database cannot be read: the caller decides.
 */
export async function unmigratedBrainReason(): Promise<string | null> {
  const [r] = (await db.execute(
    sql`select "public"."mantle_ws_skip_reason"() as why`,
  )) as unknown as { why: string | null }[];
  const why = r?.why ?? null;
  return why === null || why === 'no brain anchor yet' ? null : why;
}

/** The boot's refusal of an unmigrated brain: what it logs before it
 *  exits. */
export function unmigratedBrainRefusal(why: string): string {
  return `[workspaces] this brain is not on workspaces (${why}), and this release has no rule for one: it does not start. Switch it by hand as docs/workspaces.md "Operator notes" says (mantle_ws_migrate_locked), then start it again.`;
}

/** Onboarding, after the manifest seed made the assistants, in the scope
 *  of the login that runs it. Never throws. */
export async function attachDefaultAssistantsQuietly(when: string, loginId: string): Promise<void> {
  try {
    const attached = await attachDefaultAssistants(loginId);
    if (attached) console.log(`[workspaces] ${when}: attached ${attached} default assistant(s)`);
  } catch (err) {
    failure(when, err);
  }
}
