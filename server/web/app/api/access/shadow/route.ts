/**
 * GET /api/access/shadow?days=30 -> the access shadow report: what the team
 * responder would lose at team level today (member logins Phase 0b). Owner
 * only, read-only, no model call. See @mantle/content access-shadow.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { accessShadowReport } from '@mantle/content';

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = Number(new URL(req.url).searchParams.get('days') ?? '30');
  const days = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 365) : 30;
  return NextResponse.json(await accessShadowReport(user.id, { days }));
}
