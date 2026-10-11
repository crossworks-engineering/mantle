import { LIBRARY_GONE_MESSAGE, gone } from '@/lib/gone';

/**
 * GET /api/member/accepted
 * Removed in workspaces W7e (unused since W6b): review is gone (W5c), and
 * what a member wrote is a brain item in its private workspace, read through
 * the normal routes in the login's scope. The old guard runs first, then 410
 * `{ error, code: 'gone' }`.
 */
export const GET = gone('member', LIBRARY_GONE_MESSAGE);
