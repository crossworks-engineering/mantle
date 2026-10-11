import { gone } from '@/lib/gone';

/**
 * POST /api/member/space/:id/share
 * Removed in workspaces W5c (team drafts). A member gets 410 `{ error, code: 'gone' }`;
 * the member guard runs first, as before.
 */
export const POST = gone('member');
