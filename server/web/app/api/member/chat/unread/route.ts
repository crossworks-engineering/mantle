/**
 * GET /api/member/chat/unread
 *
 * Gone (workspaces W7c): unread counts are per thread now
 * (GET /api/assistant/conversations). The member guard runs first, then 410.
 */
import { gone } from '@/lib/gone';

export const GET = gone('member', 'Chat moved to the assistant screen. Update the app.');
