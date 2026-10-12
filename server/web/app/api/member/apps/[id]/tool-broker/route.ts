import { MEMBER_ROUTES_GONE_MESSAGE, gone } from '@/lib/gone';

/**
 * POST /api/member/apps/:id/tool-broker
 * Removed in workspaces W8d (deprecated since W7e): every login runs an app
 * through POST /api/apps/:id/tool-broker (lib/app-runner.ts, the same
 * rules). The member guard runs first, then 410 `{ error, code: 'gone' }`.
 */
export const POST = gone('member', MEMBER_ROUTES_GONE_MESSAGE);
