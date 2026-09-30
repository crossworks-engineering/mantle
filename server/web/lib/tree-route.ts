/**
 * The item tree's route plumbing (docs/folder-tree.md): the `:kind` param,
 * refusals as HTTP answers, and the caller's own private items at the root.
 * The routes under app/api/tree stay a few lines each.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  isTreeKind,
  TREE_SEARCH_MAX,
  TREE_SORTS,
  type TreeItem,
  type TreeKind,
} from '@mantle/client-types/tree';
import {
  ensureKindRoot,
  READER_TREE_KINDS,
  isTreeLiveKind,
  reconcileAppMarks,
  reconcileAppNav,
  reconcileNotesAutoFiled,
  TreeError,
  TreeVisibilityError,
} from '@mantle/content/tree';
import { ensureFilesRootBranch } from '@/lib/files';
import { allPrivateRows } from '@/lib/admin-private-rows';
import type { MemberCaller, SessionUser } from '@/lib/auth';
import type { MemberTreeScope } from '@mantle/content/tree';

/** A member's tree scope: its brain, its own space and its login. */
export function memberTreeScope(member: MemberCaller): MemberTreeScope {
  return { anchorId: member.anchorId, spaceId: member.spaceId, loginId: member.loginId };
}

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

/** Make sure the kind's root exists before its first read or write, and move
 *  in what older brains kept elsewhere (once). `actorId` is the login, for
 *  its own marks. */
/** What this process has already ensured (owner, kind, login): the root,
 *  and the once-only moves below, are done for good once done, so a tree read
 *  after the first skips the writes (audit P9). */
const ensured = new Set<string>();

export async function ensureTreeRoot(
  ownerId: string,
  kind: TreeKind,
  actorId?: string,
): Promise<void> {
  const key = `${ownerId}:${kind}:${actorId ?? ''}`;
  if (ensured.has(key)) return;
  await ensureTreeRootOnce(ownerId, kind, actorId);
  ensured.add(key);
}

async function ensureTreeRootOnce(
  ownerId: string,
  kind: TreeKind,
  actorId?: string,
): Promise<void> {
  if (kind === 'files') await ensureFilesRootBranch(ownerId);
  else await ensureKindRoot(ownerId, kind);
  // Older digests move into Notes / Auto-filed / Assistant once.
  if (kind === 'notes') await reconcileNotesAutoFiled(ownerId);
  // The Apps layout document and this login's app pins and opens.
  if (kind === 'apps') {
    await reconcileAppNav(ownerId);
    if (actorId) await reconcileAppMarks(ownerId, actorId);
  }
}

/** A TreeError as its HTTP answer; anything else is rethrown (a 500). */
export function treeErrorResponse(err: unknown): NextResponse {
  // Who can see items would change: the list, so the caller can ask and
  // repeat with confirm (TreeVisibilityRefusal).
  if (err instanceof TreeVisibilityError) {
    return NextResponse.json(
      {
        error: 'visibility',
        changes: err.diff.changes,
        total: err.diff.total,
        ...(err.diff.alsoLowered?.length ? { alsoLowered: err.diff.alsoLowered } : {}),
      },
      { status: 409 },
    );
  }
  if (err instanceof TreeError) {
    const status = err.code === 'not-found' ? 404 : err.code === 'conflict' ? 409 : 400;
    return NextResponse.json({ error: err.message }, { status });
  }
  throw err;
}

/** The kinds whose admin can keep private items (a space of their own). */
const PRIVATE_KIND = { files: 'file', notes: 'note', draw: 'draw', tables: 'table' } as const;

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
    subtype: kind === 'files' ? extensionOf(r.title) : null,
    level: 'admin',
    state: 'private',
    updatedAt: r.updatedAt,
  }));
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

/** The kind named by a member or client tree route, or a 404 when those
 *  trees do not serve it (READER_TREE_KINDS: the kinds a Library holds). */
export async function readerTreeKindOr404(ctx: {
  params: Promise<{ kind: string }>;
}): Promise<TreeKind | Response> {
  const { kind } = await ctx.params;
  if (!isTreeKind(kind) || !READER_TREE_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return kind;
}

/** A member or client tree folder page query. */
export const ReaderTreeQuery = z.object({
  folder: z.string().uuid().optional(),
  cursor: z.string().max(500).optional(),
  sort: z.enum(TREE_SORTS).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/** A member or client tree search query: no level or tag filter (levels are
 *  staff information; a reader's tags filter is not offered). */
export const ReaderTreeSearchQuery = z.object({
  q: z.string().trim().max(TREE_SEARCH_MAX).default(''),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().positive().optional(),
});
