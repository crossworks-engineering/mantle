/**
 * PATCH /api/access/agents/:slug: removed in workspaces W7b (agent and tool-group levels went: every login has the
 * one MCP surface in its own workspaces, and nothing has a level). Answers
 * 410 to an old UI after the owner guard it had (lib/gone.ts).
 */
import { gone, LEVELS_GONE_MESSAGE } from '@/lib/gone';

export const PATCH = gone('owner', LEVELS_GONE_MESSAGE);
