/**
 * The page of a comment thread a GET asks for (client logins C5 audit, I2):
 * the newest page by default, `?before=<ISO createdAt of the oldest comment
 * shown>` for the one before it. Every thread route reads through this, so
 * no thread is ever read whole.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { CommentPageQuery } from '@mantle/content';

const Query = z.object({ before: z.string().datetime({ offset: true }).optional() });

/** The page query of `req`, or a 400 for a `before` that is not an ISO time. */
export function commentPageQuery(req: Request): CommentPageQuery | Response {
  const before = new URL(req.url).searchParams.get('before');
  const parsed = Query.safeParse(before === null ? {} : { before });
  if (!parsed.success) {
    return NextResponse.json({ error: '`before` must be an ISO time.' }, { status: 400 });
  }
  return { before: parsed.data.before ? new Date(parsed.data.before) : null };
}
