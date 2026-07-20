/**
 * Near-duplicate entity consolidation. Detects candidate pairs (tiered
 * auto / review — see @mantle/content/entity-dedup) and merges them, re-pointing
 * every edge + fact to the canonical and folding the variant in as an alias.
 *
 * FREE — pure DB work, no LLM calls. DRY-RUN by default: prints the candidates
 * grouped by tier so you can eyeball them. Flags:
 *   (none)              dry-run — list candidates, change nothing
 *   --go                apply the AUTO tier (high-confidence, evidence-backed)
 *   --include-review    also apply the REVIEW tier (use after eyeballing)
 *   --merge=<canon>,<dup>   merge one specific pair by entity id
 *
 * Usage:
 *   tsx scripts/entities-dedupe.ts                  # see what it would do
 *   tsx scripts/entities-dedupe.ts --go             # apply auto-tier merges
 *   tsx scripts/entities-dedupe.ts --go --include-review
 */
import { db, nodes } from '@mantle/db';
import { mergeEntities, type MergeCandidate } from '@mantle/content';
import { runEntitiesDedupe } from '../lib/maintenance/sweeps';

function arg(name: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}
const has = (f: string) => process.argv.includes(`--${f}`);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('entities-dedupe: DATABASE_URL must be set');
    process.exit(1);
  }
  const [owner] = await db.select({ id: nodes.ownerId }).from(nodes).limit(1);
  if (!owner) {
    console.log('No owner found.');
    return;
  }
  const ownerId = owner.id;

  // Manual one-pair merge.
  const manual = arg('merge');
  if (manual) {
    const [canon, dup] = manual.split(',').map((s) => s.trim());
    if (!canon || !dup) {
      console.error('--merge expects <canonicalId>,<dupId>');
      process.exit(1);
    }
    const ok = await mergeEntities(ownerId, canon, dup);
    console.log(ok ? `Merged ${dup} → ${canon}` : 'Merge failed (id not found / not owned).');
    return;
  }

  const applyAuto = has('go');
  const applyReview = has('include-review');

  // Shared with the nightly cron sweep (lib/maintenance/sweeps.ts) — one
  // definition of what this hygiene job does. Both tiers false = dry-run.
  const res = await runEntitiesDedupe(ownerId, { applyAuto, applyReview });

  const print = (label: string, list: MergeCandidate[]) => {
    console.log(`\n── ${label} (${list.length}) ───────────────────────────────`);
    for (const c of list) {
      console.log(`  "${c.dupName}"  →  "${c.canonicalName}"  [${c.kind}]  — ${c.reason}`);
    }
  };
  print('AUTO (high-confidence)', res.auto);
  print('REVIEW (needs your eye)', res.review);

  if (!applyAuto && !applyReview) {
    console.log(
      '\nDRY RUN — nothing changed. --go applies AUTO; add --include-review for the rest.',
    );
    return;
  }
  console.log(`\nApplied ${res.merged}/${res.attempted} merges.`);
}

main()
  .catch((err) => {
    console.error('[entities-dedupe] fatal:', err);
    process.exit(1);
  })
  .finally(() => (db as unknown as { $client: { end: () => Promise<void> } }).$client.end());
