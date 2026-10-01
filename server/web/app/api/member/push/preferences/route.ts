import { getMemberOr401 } from '@/lib/auth';
import { loginPushPrefs, loginPushPrefsUpdate } from '@/lib/push/login-routes';

/**
 * GET/PUT /api/member/push/preferences: this login's own push toggles
 * (0211): { chatReplies, reviewResults, comments }, all on by default. PUT
 * takes a partial patch; unknown or mistyped fields are ignored.
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  return loginPushPrefs(member);
}

export async function PUT(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  return loginPushPrefsUpdate(req, member);
}
