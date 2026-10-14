import { MEMBER_ROUTES_GONE_MESSAGE, gone } from '@/lib/gone';

/**
 * GET /api/member/files/:id
 * Removed in workspaces W8d (deprecated since W7e): every login reads a
 * file's bytes on GET /api/files/files/:id?raw=1 (and ?thumb=1) in its own
 * scope. The old guard (a member session or a member `?at=` asset token)
 * answers first, at the gate (A4 hand batch B), then 410 `{ error, code: 'gone' }`.
 */
export const GET = gone('member-asset', MEMBER_ROUTES_GONE_MESSAGE);
