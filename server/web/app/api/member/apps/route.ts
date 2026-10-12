import { MEMBER_ROUTES_GONE_MESSAGE, gone } from '@/lib/gone';

/**
 * GET /api/member/apps
 * Removed in workspaces W8d (deprecated since W7e): every login lists the
 * apps its workspaces hold through the normal app routes and runs one on
 * /api/apps/:id (lib/app-runner.ts, the same rules). The member guard runs
 * first, then 410 `{ error, code: 'gone' }`.
 */
export const GET = gone('member', MEMBER_ROUTES_GONE_MESSAGE);
