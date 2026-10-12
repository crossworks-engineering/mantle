import { goneResponse } from '@/lib/gone';

/**
 * GET and POST /api/auth/client-code (public): removed in workspaces W8a.
 * There is no email-code sign-in and no client login any more: every login
 * signs in with its password. Every caller gets 410 code gone, before any
 * work (no session is read, nothing is queued), so an old sign-in page can
 * say so.
 */
export async function GET(): Promise<Response> {
  return goneResponse(CLIENT_CODE_GONE_MESSAGE);
}

export async function POST(): Promise<Response> {
  return goneResponse(CLIENT_CODE_GONE_MESSAGE);
}

const CLIENT_CODE_GONE_MESSAGE = 'Email-code sign-in has ended. Sign in with your password.';
