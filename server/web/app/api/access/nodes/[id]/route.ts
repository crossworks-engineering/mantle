/**
 * GET   /api/access/nodes/:id  -> the item's level, its closure (what it
 *                                 embeds / a folder's contents), its link
 *                                 and what the control may offer.
 * PATCH /api/access/nodes/:id  { audience, withClosure?, raiseClosure? } -> set the level;
 *                                 what a page, drawing or note embeds goes
 *                                 down with it (`alsoLowered`); the link
 *                                 follows it (none at admin or team, open at
 *                                 client and public).
 *
 * Owner only. The Access control's API. The rules (type ceiling, embeds
 * follow an item down and are never raised, a folder's contents only on
 * request, levels drive links) live in @mantle/content access.ts,
 * embed-closure.ts and shares.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import {
  AccessError,
  acceptedAuthors,
  accessClosure,
  canShareNode,
  contactSharesForNode,
  EMBEDDING_KINDS,
  getActiveShareForNode,
  isWorkspaceKind,
  oldLinksAboveItem,
  setItemLevel,
  readThroughEmbeds,
  sharedViaFolder,
  type ShareSummary,
} from '@mantle/content';
import { db, isViewerLevel, nodes, VIEWER_LEVELS } from '@mantle/db';
import type { AccessLinkView, AccessNodeUpdate, AccessNodeView } from '@mantle/client-types';

const IdParams = z.object({ id: z.string().uuid() });

/** The link as the control shows it. `path` is server-relative (/s/<token>). */
function linkView(share: ShareSummary | null): AccessLinkView | null {
  return share
    ? {
        id: share.id,
        token: share.token,
        path: `/s/${share.token}`,
        mode: share.mode,
        cascade: share.cascade,
      }
    : null;
}

const PatchBody = z.object({
  audience: z.enum(VIEWER_LEVELS),
  /** Folders only: also lower the folder's contents. */
  withClosure: z.boolean().optional(),
  /** Also raise the closure items still below the new level. */
  raiseClosure: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const [item] = await db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      audience: nodes.audience,
      path: nodes.path,
    })
    .from(nodes)
    .where(and(eq(nodes.id, idParsed.data.id), eq(nodes.ownerId, user.id)))
    .limit(1);
  if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const [closure, share, childCount, authors, oldLinks, sharedVia, readThrough, contactShares] =
    await Promise.all([
      accessClosure(user.id, item.id),
      getActiveShareForNode(user.id, item.id),
      // Always 0 since folder phase 7 (pages do not nest); kept on the wire.
      Promise.resolve(0),
      acceptedAuthors(user.id, [item.id]),
      // Old live links above a client item (a client folder over it, a client
      // page embedding it): anyone with one opens this item too (audit A11).
      item.audience === 'client' ? oldLinksAboveItem(user.id, item.id) : Promise.resolve([]),
      // The shared folder it takes its share from: the control's floor.
      sharedViaFolder(user.id, item.id),
      // What embeds it and carries a share (0208): a floor too.
      readThroughEmbeds(user.id, item.id),
      // The contacts it is shared with (contact shares, 0214): no level.
      contactSharesForNode(user.id, item.id),
    ]);
  const { path, ...rest } = item;
  const body: AccessNodeView = {
    item: { ...rest, audience: isViewerLevel(rest.audience) ? rest.audience : 'admin' },
    closure,
    share: linkView(share),
    childCount,
    // What the control may offer: below admin only for workspace kinds; a
    // link only where the item can carry one (not a folder outside files).
    canLower: isWorkspaceKind(item.type),
    canLink: canShareNode({ type: item.type, path }),
    // A page's, drawing's or note's embeds go down with it (embedding means
    // sharing); a folder's contents do not.
    embedsFollow: EMBEDDING_KINDS.includes(item.type),
    // A member wrote it and an admin accepted it (member logins Phase 4).
    author: authors.get(item.id) ?? null,
    // A NEW open link is made at public only (client logins C1).
    openLinkLevels: ['public'],
    ...(item.audience === 'client' ? { oldLinksAbove: oldLinks } : {}),
    sharedVia,
    readThrough,
    contactShares,
  };
  return NextResponse.json(body);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'Invalid input.') },
      { status: 400 },
    );
  }
  try {
    const res = await setItemLevel(user.id, idParsed.data.id, parsed.data.audience, {
      withClosure: parsed.data.withClosure === true,
      raiseClosure: parsed.data.raiseClosure === true,
    });
    const body: AccessNodeUpdate = { ...res, share: linkView(res.share) };
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === 'not_found' ? 404 : 400 },
      );
    }
    throw err;
  }
}
