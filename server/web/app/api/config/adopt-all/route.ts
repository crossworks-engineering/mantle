import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { adoptManifestItem, type AdoptKind } from '@/lib/system-manifest';
import { computeConfigDiff } from '@/lib/system-manifest/config-diff-db';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

// Apply order: groups + skills before agents (so grants resolve), persona after
// its specialists exist, workers last.
const KIND_ORDER: AdoptKind[] = ['tool-group', 'skill', 'agent', 'persona', 'worker'];

/**
 * Adopt every adoptable item at once. Excludes a MODIFIED worker (re-modeling an
 * operator-tuned worker stays a deliberate per-item click); missing workers are
 * still created. Returns how many items were applied.
 */
export async function POST() {
  const user = ownerCaller();
  // A missing key (InputError) answers 400 by the one table; a
  // fault the opaque 500.
  const report = await computeConfigDiff(user.id);
  const items = report.entities
    .filter((e) => e.adoptable)
    .filter((e) => !(e.kind === 'worker' && e.status === 'modified'))
    .sort(
      (a, b) => KIND_ORDER.indexOf(a.kind as AdoptKind) - KIND_ORDER.indexOf(b.kind as AdoptKind),
    );
  for (const e of items) await adoptManifestItem(user.id, e.kind as AdoptKind, e.slug);
  return NextResponse.json({ ok: true, count: items.length });
}
