import { anyLoginAssetCaller } from '@/lib/auth';
import { servePersonPhoto } from '@/lib/people';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
});

/**
 * GET /api/messenger/photo/:loginId?v=<photoVersion>: the older path of
 * GET /api/people/:id/photo, kept for the chat window that loads it. The
 * same handler (servePersonPhoto: the people gate, the one 404, the
 * headers of /api/profile/photo) and the same callers: a session, or the
 * login's own `?at=` asset token for an <img> of the desktop app or the
 * phone (anyLoginAssetCaller).
 */
export async function GET(req: Request, ctx: { params: Promise<{ loginId: string }> }) {
  const login = anyLoginAssetCaller();
  const { loginId } = await ctx.params;
  return servePersonPhoto(req, login, loginId);
}
