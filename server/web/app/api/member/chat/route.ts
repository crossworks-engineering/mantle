/**
 * GET  /api/member/chat
 * POST /api/member/chat
 *
 * Gone (workspaces W7c): a member's thread with the Team workspace's
 * assistant is an ordinary per-(agent, login) thread now, read and written
 * through /api/assistant/* like every user's (GET /api/assistant/thread,
 * POST /api/assistant/turn). The member guard runs first, then 410
 * `{ error, code: 'gone' }`.
 */
import { gone } from '@/lib/gone';

const MOVED = 'Chat moved to the assistant screen. Update the app.';

export const GET = gone('member', MOVED);
export const POST = gone('member', MOVED);
