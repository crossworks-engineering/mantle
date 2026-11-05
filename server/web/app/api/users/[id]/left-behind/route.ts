import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { leaverReport } from '@/lib/leaver-report';
import { oidcOn } from '@/lib/oidc/settings';
import { scimOn } from '@/lib/scim/settings';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'users' },
});

const IdParams = z.object({ id: z.string().uuid() });

/**
 * GET /api/users/:id/left-behind: what a login leaves behind (its live
 * credentials, its private items and their live share links, the
 * workspaces it moderates), for an admin after a leaver's disable
 * (lib/leaver-report.ts, docs/scim.md). Only while company sign-in or SCIM
 * is on; else 404.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  ownerCaller();
  if (!oidcOn() && !scimOn()) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const id = IdParams.safeParse(await ctx.params);
  if (!id.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const report = await leaverReport(id.data.id.toLowerCase());
  if (!report) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  return NextResponse.json(report);
}
