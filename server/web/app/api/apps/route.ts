/**
 * /api/apps — list (GET) + create (POST) mini apps. Mirrors /api/pages.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { createApp, listApps, countApps, type AppSort } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';

export const runtime = 'nodejs';

const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const query = url.searchParams.get('q')?.trim() || undefined;
  const tag = url.searchParams.get('tag')?.trim() || undefined;
  const sort = (url.searchParams.get('sort') as AppSort | null) ?? undefined;
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [apps, total] = await Promise.all([
    listApps(user.id, { query, tag, sort, limit: PAGE_SIZE, offset }),
    countApps(user.id, { query, tag }),
  ]);
  return NextResponse.json({ apps, total, page, pageSize: PAGE_SIZE });
}

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(280).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const app = await createApp(user.id, { title: parsed.data.name, ...parsed.data });
  void recordIngest({
    source: 'page_create',
    ownerId: user.id,
    nodeId: app.id,
    summary: `App created: ${app.title.slice(0, 80)}`,
    payload: { title: app.title, via: 'web_api', kind: 'app' },
    snippet: app.title,
  });
  return NextResponse.json({ app }, { status: 201 });
}
