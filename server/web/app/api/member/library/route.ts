import { LIBRARY_GONE_MESSAGE, gone } from '@/lib/gone';

/**
 * GET /api/member/library
 * Removed in workspaces W7e (unused since W6b): every login reads the items
 * its workspaces hold through the normal routes (/api/tree/:kind, /api/pages,
 * /api/notes, ...) in its own scope. The old guard runs first, then 410
 * `{ error, code: 'gone' }`.
 */
export const GET = gone('member', LIBRARY_GONE_MESSAGE);
