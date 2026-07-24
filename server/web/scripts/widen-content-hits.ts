/**
 * One-time config nudge: widen the responder/assistant `content_hit_limit`
 * from the old stingy default (3) to 5.
 *
 * Why a script: the agent-settings form persists every memory_config field
 * explicitly, so existing agent rows carry `content_hit_limit: 3` and never see
 * the code default. The recall eval (docs/recall-eval.md) showed a 3-hit window
 * drops genuinely relevant near-misses below the prompt (a vehicle page ranked
 * #4, with the actual licence PDF at #3). This bumps existing rows so they get
 * the wider window; new agents already default to 5 (form + code).
 *
 * Dry-run by default (same convention as entities:dedupe / backfill:conversation):
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web tsx scripts/widen-content-hits.ts
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web tsx scripts/widen-content-hits.ts --apply
 *   ... --to=6        # target a different value
 *
 * Idempotent + reversible: only touches rows below the target; revert any time
 * at /settings/agents. Run once per environment (dev + prod).
 */

import { db, agents } from '@mantle/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

const OWNER_ID = process.env.ALLOWED_USER_ID;
if (!OWNER_ID) {
  console.error('widen-content-hits: ALLOWED_USER_ID must be set');
  process.exit(1);
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const toArg = argv.find((a) => a.startsWith('--to='));
const target = toArg ? parseInt(toArg.slice('--to='.length), 10) : 5;
if (Number.isNaN(target) || target < 1 || target > 20) {
  console.error('widen-content-hits: --to must be 1..20');
  process.exit(1);
}

async function main() {
  // Rows whose content_hit_limit is set and below the target. `->>` yields text;
  // cast to int for the comparison. Unset (null) rows already inherit the code
  // default, so we leave them alone.
  const rows = await db
    .select({ id: agents.id, slug: agents.slug, role: agents.role, mc: agents.memoryConfig })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, OWNER_ID!),
        inArray(agents.role, ['responder', 'assistant', 'custom']),
        sql`(${agents.memoryConfig}->>'content_hit_limit') is not null`,
        lt(sql`(${agents.memoryConfig}->>'content_hit_limit')::int`, target),
      ),
    );

  if (rows.length === 0) {
    console.log(`Nothing to do — no agent has content_hit_limit < ${target}.`);
    process.exit(0);
  }

  console.log(
    `${apply ? 'Updating' : 'Would update'} ${rows.length} agent(s) → content_hit_limit=${target}:`,
  );
  for (const r of rows) {
    const cur = (r.mc as Record<string, unknown>)?.content_hit_limit;
    console.log(`  ${r.slug} [${r.role}]  ${cur} → ${target}`);
    if (apply) {
      await db
        .update(agents)
        .set({
          memoryConfig: sql`${agents.memoryConfig} || ${JSON.stringify({ content_hit_limit: target })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, r.id));
    }
  }

  console.log(apply ? '\nDone.' : '\nDry run — re-run with --apply to commit.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
