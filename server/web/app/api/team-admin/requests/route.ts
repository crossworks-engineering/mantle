/**
 * /api/team-admin/requests: gone. Team admin > Requests was removed in workspaces W5c: a team request is a task tagged team-request, worked on the Tasks board.
 * The stub answers 410 `{ error, code: 'gone' }` to an admin, 401 without a session.
 */
import { gone } from '@/lib/gone';

export const GET = gone('owner', 'Team requests are tasks now. Open them on the Tasks board.');
