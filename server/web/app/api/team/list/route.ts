/**
 * GET /api/team/list?type=note|page|table|app|task|event|branch — one page of
 * the team-visible shares of a type: ALL active shares (team and public mode
 * alike — a member may open both), searched (`q`), sorted (`sort`), paginated
 * (`page`). This is the card list behind each /team workspace section; opening
 * a card renders /s/<token>, so the share surface (and its per-request gating)
 * stays the only content door.
 *
 * Same trust model as the rest of /api/team: self-authenticated via
 * resolveTeamChatCaller, membership liveness re-checked on every call.
 */
import { NextResponse } from '@/server/http-compat';
import {
  TEAM_WORKSPACE_TYPES,
  TEAM_SHARE_SORTS,
  pageTeamVisibleShares,
  listTeamShareTags,
  type TeamShareSort,
  type TeamWorkspaceType,
} from '@mantle/content';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';


const PAGE_SIZE = 30;
/** Tree mode returns everything at once (a hierarchy can't paginate). */
const TREE_CAP = 500;

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const type = sp.get('type') ?? '';
  if (!(TEAM_WORKSPACE_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json({ error: 'invalid type' }, { status: 400 });
  }

  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const query = sp.get('q')?.trim() || undefined;
  const tag = sp.get('tag')?.trim() || undefined;
  const sortParam = sp.get('sort');
  const sort: TeamShareSort = (TEAM_SHARE_SORTS as readonly string[]).includes(sortParam ?? '')
    ? (sortParam as TeamShareSort)
    : 'newest';
  // `tree=1` (the pages section's hierarchy view) returns the WHOLE visible
  // set in one response — a tree can't paginate, and collapsible sub-page
  // rows need every ancestor present. Capped, and the cap self-announces via
  // `truncated` so a huge share set degrades visibly, not silently.
  const tree = sp.get('tree') === '1';

  const [{ items, total }, tags] = await Promise.all([
    pageTeamVisibleShares(caller.ownerId, type as TeamWorkspaceType, {
      query,
      tag,
      sort,
      limit: tree ? TREE_CAP : PAGE_SIZE,
      offset: tree ? 0 : (page - 1) * PAGE_SIZE,
    }),
    listTeamShareTags(caller.ownerId, type as TeamWorkspaceType),
  ]);

  return NextResponse.json({
    items,
    total,
    page: tree ? 1 : page,
    pageSize: tree ? TREE_CAP : PAGE_SIZE,
    tags,
    ...(tree && total > TREE_CAP ? { truncated: true } : {}),
  });
}
