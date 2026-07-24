import path from 'node:path';
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { collectionRoot, createDocCollection, listDocCollections } from '@mantle/files';
import { formatInProfile, loadProfilePreferences } from '@mantle/content';
import { getReaderNav } from '@/lib/docs-reader';
import { getOwnerOr401 } from '@/lib/auth';


/** Doc collections + their server-formatted "last synced" strings (tz/locale
 *  stable) + a first-doc link per collection, for the /docs management pane. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [cols, prefs, nav] = await Promise.all([
    listDocCollections(user.id),
    loadProfilePreferences(user.id),
    getReaderNav(user.id),
  ]);
  const collections = cols.map((c) => ({
    id: c.id,
    key: c.key,
    label: c.label,
    origin: c.origin,
    brainDepth: c.brainDepth,
    enabled: c.enabled,
    lastReconciledAt: c.lastReconciledAt ? c.lastReconciledAt.toISOString() : null,
  }));
  const formattedReconciled: Record<string, string | null> = {};
  for (const c of cols) {
    formattedReconciled[c.id] = c.lastReconciledAt
      ? formatInProfile(c.lastReconciledAt, prefs)
      : null;
  }
  const firstDocHref: Record<string, string | null> = {};
  for (const c of nav) {
    const first = c.files[0];
    firstDocHref[c.key] = first
      ? `/docs/${encodeURIComponent(c.key)}/${first.split('/').map(encodeURIComponent).join('/')}`
      : null;
  }
  return NextResponse.json({ collections, formattedReconciled, firstDocHref });
}

const createSchema = z.object({
  label: z.string().trim().min(1, 'Label is required'),
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Key must be a lowercase slug, e.g. "guide"')
    .refine((k) => k !== 'system', 'The key "system" is reserved.'),
  rootPath: z.string().trim().min(1, 'Root path is required'),
  brainDepth: z.enum(['retrieval', 'full']),
  origin: z.string().trim().min(1).default('user'),
});

/** True when two resolved roots are equal or one nests inside the other. */
function rootsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const sep = path.sep;
  return a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * Create a new doc collection from the /docs "New collection" form. Validates,
 * guards against overlapping roots (so a new collection can't silently double-
 * index against another), then inserts + runs the first reconcile. Returns
 * {ok,message} (200) so the dialog branches on it.
 */
export async function POST(req: Request) {
  const owner = await getOwnerOr401();
  if (owner instanceof Response) return owner;
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Invalid input.',
    });
  }
  const input = parsed.data;
  try {
    const newRoot = collectionRoot({ rootPath: input.rootPath });
    const existing = await listDocCollections(owner.id);
    for (const c of existing) {
      const r = collectionRoot(c);
      if (r === newRoot) {
        return NextResponse.json({
          ok: false,
          message: `“${c.label}” already covers that exact folder.`,
        });
      }
      if (c.key === 'system') continue; // repo-docs catch-all; child collections allowed
      if (rootsOverlap(newRoot, r)) {
        return NextResponse.json({
          ok: false,
          message: `That folder overlaps the “${c.label}” collection — pick a non-nested path.`,
        });
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
    return NextResponse.json({
      ok: true,
      message: reconciled
        ? `Created ${collection.label} — indexed +${reconciled.inserted} new, ${reconciled.updated} updated, ${reconciled.noop} unchanged.`
        : `Created ${collection.label}.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|doc_collections_owner_key_uq|unique/i.test(msg)) {
      return NextResponse.json({
        ok: false,
        message: 'A collection with that key already exists.',
      });
    }
    return NextResponse.json({ ok: false, message: msg });
  }
}
