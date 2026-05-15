import { NextResponse, type NextRequest } from 'next/server';
import { googleOAuth2Client } from '@mantle/email';
import { requireOwner } from '@/lib/auth';

/**
 * Kick off the Google OAuth flow.
 *
 * Scopes requested:
 *   - gmail.readonly         — read messages and attachments
 *   - userinfo.email         — find out which mailbox this is
 *
 * `access_type=offline` + `prompt=consent` together guarantee Google
 * returns a refresh_token. Without `prompt=consent`, a second grant for
 * the same account silently drops the refresh_token from the response,
 * which strands us once the access token expires.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export async function GET(req: NextRequest) {
  await requireOwner();
  try {
    const oauth2 = googleOAuth2Client();
    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      include_granted_scopes: true,
    });
    return NextResponse.redirect(url);
  } catch (err) {
    const back = new URL('/settings/accounts', req.url);
    back.searchParams.set('error', (err as Error).message);
    return NextResponse.redirect(back);
  }
}
