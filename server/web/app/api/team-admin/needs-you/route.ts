/**
 * /api/team-admin/needs-you: gone. The Team admin "needs you" summary (review queue and requests) was removed in workspaces W5c.
 * The stub answers 410 `{ error, code: 'gone' }` to an admin, 401 without a session.
 */
import { gone } from '@/lib/gone';

export const GET = gone('owner');
