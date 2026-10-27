import { NextResponse } from '@/server/http-compat';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a messenger attachment, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

/** POST /api/messenger/attachments: the upload of an attachment's bytes
 *  arrives with Messenger Phase 4 (plan page d8954876 section 9). Until
 *  then the route answers 501 and reads nothing. */
export async function POST() {
  return NextResponse.json(
    { error: 'Attachments are not available yet.', code: 'not_implemented' },
    { status: 501 },
  );
}
