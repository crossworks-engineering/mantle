/**
 * Print the LIVE delegate roster each delegating agent's model receives —
 * the exact text the `invoke_agent` dynamic-schema hook appends to the tool
 * description at toolset-assembly time (packages/tools/src/delegate-roster.ts).
 *
 * The roster is derived from grants and never stored, so this is the way to
 * SEE what the model is being told without capturing a real turn. Read-only.
 *
 * Usage (against the local .env.local database):
 *   pnpm -C server/web roster:dump              # every enabled agent with delegates
 *   pnpm -C server/web roster:dump assistant    # just that agent slug
 *
 * On a deployed box, run inside the web container:
 *   docker exec -it mantle_web sh -c \
 *     'cd /app/server/web && node_modules/.bin/tsx scripts/roster-dump.ts'
 */

import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { agents, db } from '@mantle/db';
import { buildDelegateRoster } from '@mantle/tools';

export async function dumpRosters(onlySlug?: string): Promise<void> {
  const rows = await db.select().from(agents).where(eq(agents.enabled, true));
  const delegating = rows.filter(
    (r) =>
      (!onlySlug || r.slug === onlySlug) &&
      Array.isArray(r.memoryConfig?.delegate_to) &&
      r.memoryConfig.delegate_to!.length > 0,
  );
  if (delegating.length === 0) {
    console.log(
      onlySlug
        ? `no enabled agent '${onlySlug}' with a non-empty memory_config.delegate_to`
        : 'no enabled agents with a non-empty memory_config.delegate_to',
    );
    return;
  }
  for (const agent of delegating) {
    const delegateTo = agent.memoryConfig.delegate_to!;
    const roster = await buildDelegateRoster(agent.ownerId, delegateTo);
    console.log(`=== ${agent.slug} (role ${agent.role}) delegates: ${delegateTo.join(', ')}`);
    console.log(roster || '(empty roster — the description gets no roster section)');
    console.log();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  dumpRosters(process.argv[2])
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[roster-dump] failed:', err);
      process.exit(1);
    });
}
