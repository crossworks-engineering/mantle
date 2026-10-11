import { LIBRARY_GONE_MESSAGE, gone } from '@/lib/gone';

/**
 * GET /api/member/library/:id
 * Removed in workspaces W7e (unused since W6b): see /api/member/library.
 * The old guard runs first, then 410 `{ error, code: 'gone' }`.
 */
export const GET = gone('member', LIBRARY_GONE_MESSAGE);
