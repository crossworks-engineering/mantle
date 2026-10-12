import { gone } from '@/lib/gone';

const MESSAGE = 'Email-code sign-in has ended: there is no sign-in sender.';

/** GET and PUT /api/team-admin/clients/signin-sender: removed in workspaces
 *  W8a with email-code sign-in (there is no sign-in sender). The old admin
 *  guard runs first; an admin gets 410 code gone. */
export const GET = gone('owner', MESSAGE);
export const PUT = gone('owner', MESSAGE);
