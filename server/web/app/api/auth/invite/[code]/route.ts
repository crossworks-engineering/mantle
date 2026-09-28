/**
 * GET /api/auth/invite/:code (public, under /api/auth): who an invite is for,
 * so the invite page can greet the person before they set a password
 * (MemberInvitePreview). Only an invite code previews (team codes are
 * retired, migration 0178). Any code that cannot be redeemed is the same
 * 404. Rate limited per IP, and for the whole brain on failed codes
 * (lib/member-invites.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { loadPreferencesFor, previewMemberInvite } from '@mantle/content';
import type { MemberInvitePreview } from '@mantle/client-types';
import { inviteFailed, inviteRateLimited } from '@/lib/member-invites';

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const limited = inviteRateLimited(req, 'preview');
  if (limited) return limited;
  const { code } = await ctx.params;
  const invite = typeof code === 'string' ? await previewMemberInvite(code) : null;
  if (!invite) {
    inviteFailed('preview');
    return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
  }
  const brain = await loadPreferencesFor(invite.ownerId);
  const body: MemberInvitePreview = {
    email: invite.email,
    displayName: invite.displayName,
    siteName: brain.siteName ?? null,
  };
  return NextResponse.json(body);
}
