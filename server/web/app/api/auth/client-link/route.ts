import { goneResponse } from '@/lib/gone';

/**
 * POST /api/auth/client-link (public): removed in workspaces W5c. Admin-issued
 * client sign-in links are gone; a client signs in with an emailed code
 * (POST /api/auth/client-code). Every caller gets 410 code gone, before any
 * work, so an old link page can say so.
 */
export async function POST(): Promise<Response> {
  return goneResponse('Sign-in links have ended. Sign in with an email code.');
}
