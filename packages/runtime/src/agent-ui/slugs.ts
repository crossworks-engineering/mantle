/**
 * The agent UI tool slugs (docs/agent-ui.md), a leaf: the turn assembly
 * offers them by name without loading the tools' runtime. tools.ts defines
 * one tool per action, in this order.
 */
import { AGENT_UI_ACTIONS } from '@mantle/client-types/agent-ui';

/** The ui tool slugs, in the order they are offered. */
export const AGENT_UI_TOOL_SLUGS: readonly string[] = AGENT_UI_ACTIONS.map((a) => `ui_${a}`);

/** The ui tools a turn is offered: all of them, but `ui_look` only to a
 *  model that sees images (its answer is a picture). */
export function agentUiToolSlugsFor(seesImages: boolean): readonly string[] {
  return seesImages ? AGENT_UI_TOOL_SLUGS : AGENT_UI_TOOL_SLUGS.filter((s) => s !== 'ui_look');
}
