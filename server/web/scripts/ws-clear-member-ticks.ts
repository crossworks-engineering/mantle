/**
 * ws:clear-member-ticks (migration 0286, owner answer Q1): clear the
 * Moderator tick of every user of ONE workspace who is not an Admin user,
 * right after the roll. What an Admin user does by hand on Settings >
 * Workspaces, in one go. lib/workspace-ticks.ts has the rule.
 *
 * Usage:
 *   pnpm -C server/web ws:clear-member-ticks --workspace <id>            # DRY RUN: counts only
 *   pnpm -C server/web ws:clear-member-ticks --workspace <id> --apply    # clear them
 *   --workspace former-team   the workspace 0286 made normal (no id needed)
 *
 * Admin users keep their tick, and the workspace keeps at least one
 * Moderator (with no Admin user among them, the member added first keeps
 * it). Never removes a row. Each change writes the workspace_events row the
 * workspace screen writes (user.moderator), with no actor and `by` naming
 * this command. Runs as system(script:ws-clear-member-ticks)
 * (docs/actors.md). Numbers only.
 *
 * Exit codes: 0 done · 1 crash or a bad argument · 2 refused (no such
 * workspace, the Admin workspace, an archived one).
 */
import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { clearMemberTicks } from '../lib/workspace-ticks';

if (!env('DATABASE_URL')) {
  console.error('ws-clear-member-ticks: DATABASE_URL must be set');
  process.exit(1);
}

const args = process.argv.slice(2);
let workspace: string | null = null;
let apply = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--apply') apply = true;
  else if (a === '--workspace' && args[i + 1] && !args[i + 1]!.startsWith('--')) {
    workspace = args[++i]!;
  } else {
    console.error(`ws-clear-member-ticks: unknown argument ${a}`);
    process.exit(1);
  }
}
if (!workspace) {
  console.error('ws-clear-member-ticks: --workspace <id|former-team> is required');
  process.exit(1);
}

const WHY = {
  not_found: 'no such workspace on this brain',
  archived: 'the workspace is archived',
  admin_workspace: 'the Admin workspace: its Moderators are Admin users',
} as const;

async function main(): Promise<number> {
  const r = await clearMemberTicks(workspace!, apply);
  if (!r.ok) {
    console.error(`[ws-clear-member-ticks] refused: ${WHY[r.reason]}`);
    return 2;
  }
  console.log(
    `[ws-clear-member-ticks] ${r.applied ? 'APPLIED' : 'DRY RUN'}: ` +
      `Moderators ${r.moderators}, of them Admin users ${r.adminModerators}, ` +
      `${r.applied ? 'cleared' : 'to clear'} ${r.cleared}, ` +
      `kept as the last Moderator ${r.keptForLastModerator}` +
      (r.applied ? '' : '\n  nothing written (--apply clears them)'),
  );
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch((err) => {
    console.error('[ws-clear-member-ticks] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
