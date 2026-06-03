'use server';

import { requireOwner } from '@/lib/auth';
import { listDocCollections, setCollectionEnabled } from '@mantle/files';

export type DocCollectionView = {
  id: string;
  key: string;
  label: string;
  origin: string;
  brainDepth: string;
  enabled: boolean;
  lastReconciledAt: string | null;
};

export type DocActionResult = { ok: boolean; message: string };

export async function listDocCollectionsAction(): Promise<DocCollectionView[]> {
  const owner = await requireOwner();
  const cols = await listDocCollections(owner.id);
  return cols.map((c) => ({
    id: c.id,
    key: c.key,
    label: c.label,
    origin: c.origin,
    brainDepth: c.brainDepth,
    enabled: c.enabled,
    lastReconciledAt: c.lastReconciledAt ? c.lastReconciledAt.toISOString() : null,
  }));
}

/** Flip one collection. Enabling reconciles immediately; disabling purges its
 *  indexed nodes. Returns a human message summarising what happened. */
export async function toggleDocCollectionAction(
  id: string,
  enabled: boolean,
): Promise<DocActionResult> {
  const owner = await requireOwner();
  try {
    const res = await setCollectionEnabled(owner.id, id, enabled);
    if (!res) return { ok: false, message: 'Collection not found.' };
    if (enabled && res.reconciled) {
      const r = res.reconciled;
      return {
        ok: true,
        message: `Indexed ${res.collection.label}: +${r.inserted} new, ${r.updated} updated, ${r.noop} unchanged.`,
      };
    }
    return {
      ok: true,
      message: `Disabled ${res.collection.label} — removed ${res.purged ?? 0} indexed doc(s).`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Enable or disable every collection at once. */
export async function setAllDocCollectionsAction(enabled: boolean): Promise<DocActionResult> {
  const owner = await requireOwner();
  try {
    const cols = await listDocCollections(owner.id);
    let changed = 0;
    for (const c of cols) {
      if (c.enabled !== enabled) {
        await setCollectionEnabled(owner.id, c.id, enabled);
        changed++;
      }
    }
    return {
      ok: true,
      message: changed === 0
        ? `All collections already ${enabled ? 'enabled' : 'disabled'}.`
        : `${enabled ? 'Enabled' : 'Disabled'} ${changed} collection(s).`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
