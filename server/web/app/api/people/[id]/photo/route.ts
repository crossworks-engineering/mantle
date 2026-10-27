import { anyLoginAssetCaller } from '@/lib/auth';
import { servePersonPhoto } from '@/lib/people';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['peopleRead'] } },
});

/**
 * GET /api/people/:id/photo?v=<photoVersion>: a person's uploaded photo,
 * for anyone who may see that person (the people gate); everything else is
 * the one 404 (servePersonPhoto). The caller is a session (cookie or
 * bearer) or, for an <img> of the desktop app or the phone, which carries
 * neither, the login's own short-lived `?at=` asset token, the one the
 * shell mints for /api/profile/photo (anyLoginAssetCaller).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginAssetCaller();
  const { id } = await ctx.params;
  return servePersonPhoto(req, login, id);
}
