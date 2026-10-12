import { goneResponse } from '@/lib/gone';

/**
 * POST /api/auth/client-code/verify (public): removed in workspaces W8a.
 * There is no email-code sign-in and no client login any more. Every caller
 * gets 410 code gone, before any work: no code is read, no session or device
 * token is minted.
 */
export async function POST(): Promise<Response> {
  return goneResponse('Email-code sign-in has ended. Sign in with your password.');
}
