/**
 * Re-render drawing snapshots (`draws.scene_svg`) through the browser sidecar.
 *
 *   pnpm -C server/web tsx scripts/draws-re-render.ts --dry-run
 *   pnpm -C server/web tsx scripts/draws-re-render.ts
 *   pnpm -C server/web tsx scripts/draws-re-render.ts --all --limit=50
 *
 * The snapshot is a CACHE of a render, not a source of truth. By default this
 * only touches drawings whose cache is empty or was drawn by a different
 * Excalidraw version (the `svg_engine` stamp), which is what makes an upstream
 * bump recoverable: pin the new version, run this, and the corpus heals.
 * `--all` re-renders everything regardless of stamp.
 *
 * Costs browser time, never tokens: the write path (setDrawSvg) deliberately
 * does not notify the extractor, so this can never trigger an LLM pass.
 * Requires BROWSER_WS_ENDPOINT (the `browser` compose service).
 */
import { db, nodes } from '@mantle/db';
import { EXCALIDRAW_ENGINE, listStaleDrawSnapshots } from '@mantle/content';
import { getDrawSvgOrRender } from '../lib/draw-snapshot';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg
  ? Math.max(1, Number.parseInt(limitArg.slice('--limit='.length), 10) || 0)
  : 500;

async function main() {
  // Every owner on the box. Personal-scale deployments have one; a shared one
  // should still heal completely rather than only the first owner found.
  const owners = await db.selectDistinct({ ownerId: nodes.ownerId }).from(nodes);

  let scanned = 0;
  let rendered = 0;
  let failed = 0;

  for (const { ownerId } of owners) {
    const stale = await listStaleDrawSnapshots(ownerId, {
      engine: EXCALIDRAW_ENGINE,
      includeRendered: all,
      limit,
    });
    if (stale.length === 0) continue;
    scanned += stale.length;

    console.log(
      `[draws-re-render] owner ${ownerId}: ${stale.length} drawing(s) ${all ? 'to re-render' : 'stale or unrendered'}`,
    );
    if (dryRun) {
      for (const d of stale) console.log(`  would render ${d.id}  ${d.title}`);
      continue;
    }

    for (const d of stale) {
      // Sequential on purpose. getDrawSvgOrRender already caps concurrency at
      // 2, and a sweep must never starve an owner's live PDF export of the
      // sidecar's session pool.
      // force: --all means "re-render", not "ensure a render exists". Without
      // it every already-current drawing returns straight from cache while
      // the script cheerfully prints a tick for each.
      const svg = await getDrawSvgOrRender(ownerId, d.id, { force: all });
      if (svg) {
        rendered++;
        console.log(`  ✓ ${d.id}  ${d.title}`);
      } else {
        failed++;
        console.log(`  · ${d.id}  ${d.title} — no snapshot (empty scene, or renderer unavailable)`);
      }
    }
  }

  if (scanned === 0) {
    console.log('[draws-re-render] nothing to do — every snapshot is current.');
    return;
  }
  console.log(
    dryRun
      ? `[draws-re-render] dry run: ${scanned} drawing(s) would be re-rendered.`
      : `[draws-re-render] done: ${rendered} rendered, ${failed} skipped, of ${scanned} scanned.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[draws-re-render] failed:', err);
    process.exit(1);
  });
