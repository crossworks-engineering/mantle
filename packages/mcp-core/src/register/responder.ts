/**
 * Responder simulation: the real pipeline (persona, retrieval, real tool
 * execution) with nothing persisted to the conversation store. Plus the one
 * opt-in write: `responder_turn_record`, which keeps a turn the client
 * answered as the agent. Their definitions, policy and bodies are in
 * mcp-defs.ts (A5 step 2); this registers them at the group's place.
 */

import { registerMcpTools } from '../mcp-defs';
import type { McpRegisterContext } from './context';

export { firstSentence } from '../mcp-defs';

export function registerResponderTools(ctx: McpRegisterContext): void {
  registerMcpTools(ctx, 'responder');
}
