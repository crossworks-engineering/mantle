/**
 * /api/apps/members/[id]/test/frame-ticket: gone. Member app review (accept, send back, test, activity) was removed in workspaces W5c. Members still build apps and share them with the team.
 * The stub answers 410 `{ error, code: 'gone' }` to an admin, 401 without a session.
 */
import { gone } from '@/lib/gone';

export const POST = gone(
  'owner',
  'Member app review was removed. Members share apps with the team in the app.',
);
