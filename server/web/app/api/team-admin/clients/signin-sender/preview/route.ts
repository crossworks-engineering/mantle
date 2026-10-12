import { gone } from '@/lib/gone';

/** GET /api/team-admin/clients/signin-sender/preview: removed in workspaces
 *  W8a with email-code sign-in. The old admin guard runs first; an admin
 *  gets 410 code gone. */
export const GET = gone('owner', 'Email-code sign-in has ended: there is no sign-in sender.');
