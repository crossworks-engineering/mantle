import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { VIEWER_LEVELS, withTeamDrafts, withViewer } from '@mantle/db';
import type { MemberItemRow } from '@mantle/client-types';
import { MEMBER_ITEM_FILTERS } from '@mantle/client-types/member-kinds';
import {
  MEMBER_ITEMS_MAX_PAGE,
  SPACE_ITEM_KINDS,
  acceptedAuthors,
  acceptedByLogin,
  acceptedItemRow,
  itemsPlan,
  libraryItemRow,
  libraryLevelsOf,
  listAccepted,
  listLibrary,
  listMine,
  listTeamDrafts,
  listWithAdmin,
  mergeNewestFirst,
  spaceItemRow,
  type PagedSource,
  type SpaceItemRow,
} from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { inMySpace } from '@/lib/member-space';

const Query = z.object({
  kind: z.enum(SPACE_ITEM_KINDS).optional(),
  q: z.string().max(200).optional(),
  state: z.enum(MEMBER_ITEM_FILTERS).default('all'),
  page: z.coerce.number().int().min(1).max(MEMBER_ITEMS_MAX_PAGE).default(1),
});
const PAGE_SIZE = 50;

/** A member reads the Library at the team level: its levels, and the rest. */
const LIBRARY_LEVELS = libraryLevelsOf('team');
const ABOVE_LIBRARY = VIEWER_LEVELS.filter(
  (l) => !(LIBRARY_LEVELS as readonly string[]).includes(l),
);

/**
 * GET /api/member/items?kind=&q=&state=&page= : everything this MEMBER can
 * see of one kind, in ONE list, newest first (item-list alignment): own items
 * (with the ones an admin took over), teammates' shared drafts, the Library,
 * and what they wrote that an admin accepted above the Library's levels.
 * Each row names its `source` and wears its `pill`; `state` narrows by pill
 * (MEMBER_ITEM_FILTERS). Every source reads under its own rules, exactly as
 * its own route does (space, team drafts, team level, the author rule on the
 * admin pool); this route only merges them (member-items.ts).
 */
export async function GET(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, state, page } = parsed.data;
  const plan = itemsPlan(state);
  const sources: PagedSource<MemberItemRow>[] = [];

  const own = plan.own;
  if (own) {
    sources.push(async (limit, offset) => {
      const res = await inMySpace(member, () =>
        listMine(member.spaceId, { kind, q, ...own, limit, offset }),
      );
      return { items: res.items.map((r) => spaceItemRow(r, 'own')), total: res.total };
    });
  }
  if (plan.withAdmin) {
    // Title and kind only, at most 200 (listWithAdmin): read once, sliced.
    let held: SpaceItemRow[] | null = null;
    sources.push(async (limit, offset) => {
      held ??= await inMySpace(member, () => listWithAdmin(member.loginId, { kind, q }));
      return {
        items: held.slice(offset, offset + limit).map((r) => spaceItemRow(r, 'own')),
        total: held.length,
      };
    });
  }
  const team = plan.team;
  if (team) {
    sources.push(async (limit, offset) => {
      const res = await withTeamDrafts(() =>
        listTeamDrafts(member.loginId, { kind, q, ...team, limit, offset }),
      );
      return { items: res.items.map((r) => spaceItemRow(r, 'team')), total: res.total };
    });
  }
  if (plan.library) {
    sources.push(async (limit, offset) => {
      const res = await withViewer('team', () =>
        listLibrary(member.anchorId, { kind, q, limit, offset }),
      );
      return { items: res.items.map((r) => libraryItemRow(r)), total: res.total };
    });
  }
  const accepted = plan.accepted;
  if (accepted) {
    sources.push(async (limit, offset) => {
      const res = await listAccepted(member.anchorId, member.loginId, {
        kind,
        q,
        order: 'updated',
        ...(accepted === 'above-library' ? { audiences: ABOVE_LIBRARY } : {}),
        limit,
        offset,
      });
      return {
        items: res.items.map((r) => acceptedItemRow(r, LIBRARY_LEVELS)),
        total: res.total,
      };
    });
  }

  const merged = await mergeNewestFirst(sources, page, PAGE_SIZE);

  // The Library rows of this page: who wrote the member-authored ones, and
  // which of them this member wrote (read on the admin pool, for exactly the
  // ids the team level returned).
  const libraryIds = merged.items.filter((r) => r.source === 'library' && !r.byMe).map((r) => r.id);
  const [authors, mine] = await Promise.all([
    acceptedAuthors(member.anchorId, libraryIds),
    acceptedByLogin(member.anchorId, member.loginId, libraryIds),
  ]);
  const items = merged.items.map((r) =>
    r.source === 'library' && !r.byMe
      ? { ...r, author: authors.get(r.id) ?? null, byMe: mine.has(r.id) }
      : r,
  );
  return NextResponse.json({ items, total: merged.total, page, pageSize: PAGE_SIZE });
}
