import { memberCaller } from '@/lib/auth';
import { loginPushPrefs, loginPushPrefsUpdate } from '@/lib/push/login-routes';

/**
 * GET/PUT /api/member/push/preferences: this login's own push toggles
 * (mobile_roles_push): { chatReplies, reviewResults }, all on by default. PUT
 * takes a partial patch; unknown or mistyped fields are ignored.
 */
export async function GET() {
  const member = memberCaller();
  return loginPushPrefs(member);
}

export async function PUT(req: Request) {
  const member = memberCaller();
  return loginPushPrefsUpdate(req, member);
}
