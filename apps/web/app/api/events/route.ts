import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { createEvent, listEvents } from '@/lib/events';

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).optional().default(''),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  remindMinutesBefore: z.number().int().min(0).max(60 * 24 * 30).optional(),
  timezone: z.string().max(64).optional(),
  recur: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
  recurUntil: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = await requireOwner();
  const url = new URL(req.url);
  const windowParam = url.searchParams.get('window');
  const window =
    windowParam === 'past' || windowParam === 'all' ? windowParam : 'upcoming';
  const rows = await listEvents(user.id, {
    query: url.searchParams.get('q') ?? undefined,
    window,
    tag: url.searchParams.get('tag') ?? undefined,
  });
  return NextResponse.json({ events: rows });
}

export async function POST(req: Request) {
  const user = await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const row = await createEvent(user.id, parsed.data);
    return NextResponse.json({ event: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}
