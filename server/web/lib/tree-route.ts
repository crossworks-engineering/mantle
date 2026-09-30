/**
 * The item tree's route plumbing (docs/folder-tree.md): the `:kind` param,
 * refusals as HTTP answers, and the caller's own private items at the root.
 * The routes under app/api/tree stay a few lines each.
 */
import { NextResponse } from '@/server/http-compat';
import { isTreeKind, type TreeItem, type TreeKind } from '@mantle/client-types/tree';
import { isTreeLiveKind, TreeError } from '@mantle/content/tree';
import { ensureFilesRootBranch } from '@/lib/files';
import { allPrivateRows } from '@/lib/admin-private-rows';
import type { SessionUser } from '@/lib/auth';

/** The kind named by the route, or a 404 when the tree does not serve it. */
export async function treeKindOr404(ctx: {
  params: Promise<{ kind: string }>;
}): Promise<TreeKind | NextResponse> {
  const { kind } = await ctx.params;
  if (!isTreeKind(kind) || !isTreeLiveKind(kind)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return kind;
}

/** Make sure the kind's root exists before its first read or write. */
export async function ensureTreeRoot(ownerId: string, kind: TreeKind): Promise<void> {
  if (kind === 'files') await ensureFilesRootBranch(ownerId);
}

/** A TreeError as its HTTP answer; anything else is rethrown (a 500). */
export function treeErrorResponse(err: unknown): NextResponse {
  if (err instanceof TreeError) {
    const status = err.code === 'not-found' ? 404 : err.code === 'conflict' ? 409 : 400;
    return NextResponse.json({ error: err.message }, { status });
  }
  throw err;
}

const PRIVATE_KIND = { files: 'file' } as const;

/**
 * The caller's own private items of a kind, as tree rows for the root
 * (item-list alignment: every list shows everything its reader can see).
 * Private items have no folder yet, so they only ever sit at the root.
 */
export async function privateRootItems(user: SessionUser, kind: TreeKind): Promise<TreeItem[]> {
  const spaceKind = kind in PRIVATE_KIND ? PRIVATE_KIND[kind as keyof typeof PRIVATE_KIND] : null;
  if (!spaceKind) return [];
  const rows = await allPrivateRows(user, spaceKind, { sort: 'title' });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    color: null,
    subtype: extensionOf(r.title),
    level: 'admin',
    state: 'private',
    updatedAt: r.updatedAt,
  }));
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}
