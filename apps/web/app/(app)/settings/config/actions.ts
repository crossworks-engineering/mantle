'use server';

/**
 * Server actions for the /settings/config adopt layer — apply the manifest
 * version of a config item to the brain. All writes go through
 * `adoptManifestItem` (lib/system-manifest), the same semantics the boot
 * reconcile uses. Read-only diffing stays in config-diff-db.ts.
 */

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/lib/auth';
import { adoptManifestItem, type AdoptKind } from '@/lib/system-manifest';
import { computeConfigDiff } from '@/lib/system-manifest/config-diff-db';

export type AdoptResult = { ok: true } | { ok: false; error: string };

/** Adopt one item (skill / tool-group / specialist / persona / worker). */
export async function adoptItemAction(kind: AdoptKind, slug: string): Promise<AdoptResult> {
  const user = await requireOwner();
  try {
    await adoptManifestItem(user.id, kind, slug);
    revalidatePath('/settings/config');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Adopt failed.' };
  }
}

// Apply order: groups + skills before agents (so grants resolve), persona after
// its specialists exist, workers last.
const KIND_ORDER: AdoptKind[] = ['tool-group', 'skill', 'agent', 'persona', 'worker'];

/**
 * Adopt every adoptable item at once. Excludes a MODIFIED worker (re-modeling an
 * operator-tuned worker stays a deliberate per-item click); missing workers are
 * still created. Returns how many items were applied.
 */
export async function adoptAllAction(): Promise<
  { ok: true; count: number } | { ok: false; error: string }
> {
  const user = await requireOwner();
  try {
    const report = await computeConfigDiff(user.id);
    const items = report.entities
      .filter((e) => e.adoptable)
      .filter((e) => !(e.kind === 'worker' && e.status === 'modified'))
      .sort(
        (a, b) =>
          KIND_ORDER.indexOf(a.kind as AdoptKind) - KIND_ORDER.indexOf(b.kind as AdoptKind),
      );
    for (const e of items) await adoptManifestItem(user.id, e.kind as AdoptKind, e.slug);
    revalidatePath('/settings/config');
    return { ok: true, count: items.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Adopt-all failed.' };
  }
}
