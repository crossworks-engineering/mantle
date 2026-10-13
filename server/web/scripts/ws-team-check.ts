/**
 * ws:team-check (migration 0286, owner answer Q1): the read-only counts an
 * operator takes for "Team is a normal workspace". Numbers only: no names,
 * no emails, no titles, no ids (client boxes print numbers only).
 *
 * Usage:
 *   pnpm -C server/web ws:team-check          # the counts
 *   pnpm -C server/web ws:team-check --json   # the same, machine-readable
 *
 * Before the roll the box runs the older image, which has no such command:
 * run the SQL block of docs/update-prod.md ("Team is a normal workspace")
 * there instead; it gives this command's second and fourth numbers (the
 * former Team's member Moderators, member-built apps with no holder). Exits
 * 0 whatever it finds: it reports, it does not gate. lib/workspace-ticks.ts
 * has the rule.
 */
import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { teamCheckCounts } from '../lib/workspace-ticks';

if (!env('DATABASE_URL')) {
  console.error('ws-team-check: DATABASE_URL must be set');
  process.exit(1);
}

for (const a of process.argv.slice(2)) {
  if (a !== '--json') {
    console.error(`ws-team-check: unknown argument ${a}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const c = await teamCheckCounts();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(c, null, 2));
    return;
  }
  const lines: Array<[string, number]> = [
    ['former Team workspace on this brain (1 yes, 0 no)', c.formerTeam],
    ['former Team Moderators who are not Admin users', c.formerTeamMemberModerators],
    ['Moderators who are not Admin users, every shared workspace', c.sharedMemberModerators],
    ['member-built apps with no holder workspace beyond Admin', c.memberAppsWithoutHolder],
  ];
  for (const [label, n] of lines) console.log(`[ws-team-check] ${label}: ${n}`);
  if (c.formerTeamMemberModerators > 0) {
    console.log(
      '[ws-team-check] an Admin user clears them on the workspace screen, or: ' +
        'pnpm -C server/web ws:clear-member-ticks --workspace former-team',
    );
  }
  if (c.memberAppsWithoutHolder > 0) {
    console.log('[ws-team-check] those apps read nothing: share each with a workspace again');
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[ws-team-check] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
