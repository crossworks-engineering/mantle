import { gone } from '@/lib/gone';

/**
 * GET /api/member/team-drafts
 * Removed in workspaces W5c (team drafts). A member gets 410 `{ error, code: 'gone' }`;
 * the member guard runs first, as before.
 */
export const GET = gone('member');
