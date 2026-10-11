/**
 * /api/team-admin/submissions/[id]/svg: gone. Review (a member submits, an admin accepts) was removed in workspaces W5c: items are shared with Grant Access.
 * The stub answers 410 `{ error, code: 'gone' }` to an admin, 401 without a session.
 */
import { gone } from '@/lib/gone';

export const GET = gone('owner', 'Review was removed. Share items with Grant Access.');
