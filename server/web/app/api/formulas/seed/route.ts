import { NextResponse } from '@/server/http-compat';
import { FORMULA_SEED, SEED_TAG } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { itemErrorText } from '@mantle/std';
import { createFormula, listFormulaSpecIds } from '@/lib/formulas';

/**
 * Add the five instructional formulas — the primer that teaches the spec format
 * by example. Idempotent: anything already present (matched on `spec.id`) is
 * skipped, so a second call adds nothing.
 *
 * Deliberately an owner ACTION rather than part of the boot reconcile. Content
 * is owner space: if the owner reads these and deletes them, an upgrade that
 * silently put them back would be the system overruling a decision the owner
 * already made. That is the one place the manifest's "product owns the
 * defaults" rule stops — and it stops here on purpose.
 */
export async function POST() {
  const user = ownerCaller();

  // Uncapped: presence is a question about ALL formulas, and the earlier
  // list-based check silently ran on the first 500 only.
  const present = await listFormulaSpecIds(user.id);

  const created: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ slug: string; error: string }> = [];

  for (const seed of FORMULA_SEED) {
    if (present.has(seed.slug)) {
      skipped.push(seed.slug);
      continue;
    }
    try {
      await createFormula(user.id, { spec: seed.spec, title: seed.title, tags: [...seed.tags] });
      created.push(seed.slug);
    } catch (err) {
      // One malformed seed must not deny the owner the other four. A spec
      // the schema refuses (FormulaSpecError) says its text; a fault is
      // logged and the item says so (fix round 1, L5).
      failed.push({
        slug: seed.slug,
        error: itemErrorText(
          err,
          'formulas/seed',
          'Could not create this formula. The details are in the server log.',
        ),
      });
    }
  }

  return NextResponse.json({ created, skipped, failed, tag: SEED_TAG });
}
