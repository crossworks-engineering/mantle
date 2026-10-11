/**
 * POST /api/member/chat/read
 *
 * Gone (workspaces W7c): read cursors are per thread now
 * (POST /api/assistant/read). The member guard runs first, then 410.
 */
import { gone } from '@/lib/gone';

export const POST = gone('member', 'Chat moved to the assistant screen. Update the app.');
