import { NextResponse } from '@/server/http-compat';
import { FORMULA_SEED, SEED_TAG } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { createFormula, listFormulas } from '@/lib/formulas';

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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const existing = await listFormulas(user.id, { limit: 500 });
  const present = new Set(existing.map((f) => f.spec?.id).filter(Boolean));

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
      // One malformed seed must not deny the owner the other four.
      failed.push({ slug: seed.slug, error: err instanceof Error ? err.message : 'failed' });
    }
  }

  return NextResponse.json({ created, skipped, failed, tag: SEED_TAG });
}
