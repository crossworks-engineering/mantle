/**
 * DELETE /api/mcp-logins/:id/tokens/:tokenId: removed in workspaces W7b (the per-login MCP switches went: every login has the
 * one MCP surface in its own workspaces, and nothing has a level). Answers
 * 410 to an old UI after the owner guard it had (lib/gone.ts).
 */
import { gone, MCP_LOGINS_GONE_MESSAGE } from '@/lib/gone';

export const DELETE = gone('owner', MCP_LOGINS_GONE_MESSAGE);
