/**
 * /api/apps: list (GET) + create (POST) mini apps. Mirrors /api/pages. Each
 * listed app carries its workspace chips and whether it has a live open link;
 * `?ws=<id>` keeps the apps that workspace holds (lib/list-workspaces.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller, ownerCallerWithLogin } from '@/lib/auth';
import { AppMetaFields } from '@/lib/app-meta';
import { createApp, listApps, countApps, notifyAppNavChanged, type AppSort } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import { parseWsFilter, workspaceChips } from '@/lib/list-workspaces';
import type { AppListResponse, AppListRow } from '@mantle/client-types';
import { readBody } from '@/lib/read-body';

const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const user = ownerCaller();
  const url = new URL(req.url);
  const filter = await parseWsFilter(req, user.id, user.actor.id);
  if (filter instanceof Response) return filter;
  const ws = filter ?? undefined;
  const query = url.searchParams.get('q')?.trim() || undefined;
  const tag = url.searchParams.get('tag')?.trim() || undefined;
  const sort = (url.searchParams.get('sort') as AppSort | null) ?? undefined;
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [rows, total] = await Promise.all([
    listApps(user.id, { query, tag, sort, ws, limit: PAGE_SIZE, offset }),
    countApps(user.id, { query, tag, ws }),
  ]);
  const chips = await workspaceChips(
    user.id,
    user.actor.id,
    rows.map((r) => r.id),
  );
  // The link pill comes with the row (listApps); the chips from the helper.
  const apps: AppListRow[] = rows.map((r) => ({
    ...r,
    workspaces: chips.get(r.id)?.workspaces ?? [],
    hasLink: r.hasLink === true,
  }));
  const body: AppListResponse = { apps, total, page, pageSize: PAGE_SIZE, ...(ws ? { ws } : {}) };
  return NextResponse.json(body);
}

const CreateBody = AppMetaFields.extend({
  tags: AppMetaFields.shape.tags.default([]),
});

export async function POST(req: Request) {
  // The owner and whether the login is an Admin user: the gate's answer for
  // this request (it read the login's row; A6b: read again on the system
  // pool before).
  const caller = ownerCallerWithLogin();
  const user = caller.user;
  const body = await readBody(req, CreateBody);
  // A member's or a client's app (W6b fix round 1, M2): at team rules (the
  // author ceiling) and its author named, as the member app tools make it.
  const admin = caller.kind === 'admin';
  const app = await createApp(user.id, {
    title: body.name,
    ...body,
    ...(admin ? {} : { authorLevel: 'team' as const, authorLoginId: user.actor.id }),
  });
  void recordIngest({
    source: 'page_create',
    ownerId: user.id,
    nodeId: app.id,
    summary: `App created: ${app.title.slice(0, 80)}`,
    payload: { title: app.title, via: 'web_api', kind: 'app' },
    snippet: app.title,
  });
  // A new app lands in the sidebar's Unsorted group on every open client.
  void notifyAppNavChanged(user.id);
  return NextResponse.json({ app }, { status: 201 });
}
