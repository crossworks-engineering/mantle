import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { parseWsFilter } from '@/lib/list-workspaces';
import { countEvents, createEvent, listEvents } from '@/lib/events';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';

const PAGE_SIZE = 50;

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).optional().default(''),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  remindMinutesBefore: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 30)
    .optional(),
  timezone: z.string().max(64).optional(),
  recur: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
  recurUntil: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = ownerCaller();
  // `?ws=<id>` keeps only what that workspace reads (as the notes and apps
  // lists do), echoed as `ws`; a workspace the login cannot see is 404.
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  const inWs = ws ? { ws } : {};
  const url = new URL(req.url);
  const windowParam = url.searchParams.get('window');
  const window: 'upcoming' | 'past' | 'all' =
    windowParam === 'past' || windowParam === 'all' ? windowParam : 'upcoming';
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const opts = {
    query: url.searchParams.get('q') ?? undefined,
    window,
    tag: url.searchParams.get('tag') ?? undefined,
    ...inWs,
  };
  const [events, total] = await Promise.all([
    listEvents(user.id, { ...opts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countEvents(user.id, opts),
  ]);
  return NextResponse.json({ events, total, page, pageSize: PAGE_SIZE, ...inWs });
}

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await createEvent(user.id, parsed.data);
  return NextResponse.json({ event: row }, { status: 201 });
}
