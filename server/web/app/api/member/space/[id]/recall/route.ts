import { gone } from '@/lib/gone';

/**
 * POST /api/member/space/:id/recall
 * Removed in workspaces W5c (review). A member gets 410 `{ error, code: 'gone' }`;
 * the member guard runs first, as before.
 */
export const POST = gone('member');
