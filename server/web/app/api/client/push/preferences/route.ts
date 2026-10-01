import { getClientOr401 } from '@/lib/auth';
import { loginPushPrefs, loginPushPrefsUpdate } from '@/lib/push/login-routes';

/**
 * GET/PUT /api/client/push/preferences: this login's own push toggles
 * (0211): { chatReplies, reviewResults, comments }, all on by default. PUT
 * takes a partial patch; unknown or mistyped fields are ignored.
 */
export async function GET() {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  return loginPushPrefs(client);
}

export async function PUT(req: Request) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  return loginPushPrefsUpdate(req, client);
}
