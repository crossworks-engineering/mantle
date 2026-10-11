import { SPACE_FOLDED_MESSAGE, gone } from '@/lib/gone';

/**
 * POST /api/member/tree/:kind/move
 * Removed in workspaces W6b (migration 0267): personal spaces folded into
 * the brain. Every personal item is a brain item in its login's private
 * workspace, read and written through the normal routes. The old guard
 * runs first, then 410 `{ error, code: 'gone' }`.
 */
export const POST = gone('member', SPACE_FOLDED_MESSAGE);
