import { gone } from '@/lib/gone';

/**
 * GET /api/member/client-requests/:id/bytes
 * Removed in workspaces W5c (client requests). A member gets 410 `{ error, code: 'gone' }`;
 * the member guard runs first, as before.
 */
export const GET = gone('member');
