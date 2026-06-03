'use server';

import path from 'node:path';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import {
  collectionRoot,
  createDocCollection,
  listDocCollections,
  setCollectionEnabled,
} from '@mantle/files';

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

const createSchema = z.object({
  label: z.string().trim().min(1, 'Label is required'),
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Key must be a lowercase slug, e.g. "guide"')
    .refine((k) => k !== 'system', 'The key "system" is reserved.'),
  // Repo-relative path under the docs root (e.g. "guide") for portable, baked-in
  // content, OR an absolute path for an external folder. Empty ⇒ the docs root
  // itself (which collides with the system collection — rejected by the guard).
  rootPath: z.string().trim().min(1, 'Root path is required'),
  brainDepth: z.enum(['retrieval', 'full']),
  origin: z.string().trim().min(1).default('user'),
});

export type CreateDocCollectionInput = z.input<typeof createSchema>;

/** True when two resolved roots are equal or one nests inside the other. */
function rootsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const sep = path.sep;
  return a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * Create a new doc collection from the /settings/documentation "New collection"
 * form. Validates, guards against overlapping roots (so a new collection can't
 * silently double-index against another), then inserts + runs the first
 * reconcile. The built-in `system` collection (root = the whole docs/ tree, and
 * ships disabled) is exempt from the prefix guard — a child collection like the
 * User Guide deliberately lives under docs/ — but an EXACT root match (incl.
 * system's) is still rejected, since that's just duplicating an existing one.
 */
export async function createDocCollectionAction(
  raw: CreateDocCollectionInput,
): Promise<DocActionResult> {
  const owner = await requireOwner();
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const input = parsed.data;

  try {
    const newRoot = collectionRoot({ rootPath: input.rootPath });
    const existing = await listDocCollections(owner.id);
    for (const c of existing) {
      const r = collectionRoot(c);
      if (r === newRoot) {
        return { ok: false, message: `“${c.label}” already covers that exact folder.` };
      }
      if (c.key === 'system') continue; // repo-docs catch-all; child collections allowed
      if (rootsOverlap(newRoot, r)) {
        return {
          ok: false,
          message: `That folder overlaps the “${c.label}” collection — pick a non-nested path.`,
        };
      }
    }

    const { collection, reconciled } = await createDocCollection(owner.id, {
      key: input.key,
      label: input.label,
      rootPath: input.rootPath,
      brainDepth: input.brainDepth,
      origin: input.origin,
      enabled: true,
    });
    const r = reconciled;
    return {
      ok: true,
      message: r
        ? `Created ${collection.label} — indexed +${r.inserted} new, ${r.updated} updated, ${r.noop} unchanged.`
        : `Created ${collection.label}.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|doc_collections_owner_key_uq|unique/i.test(msg)) {
      return { ok: false, message: 'A collection with that key already exists.' };
    }
    return { ok: false, message: msg };
  }
}
