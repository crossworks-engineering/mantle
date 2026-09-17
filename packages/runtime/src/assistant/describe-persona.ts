/**
 * Hand a responder's composed persona to an OUTSIDE caller so it can answer
 * *as* that responder in its own loop.
 *
 * This is the mirror image of run-sim-turn.ts. There, the caller asks a
 * question and the brain runs the turn: the persona, the tool allowlist, the
 * delegation edges and every guard stay server-side, where they are ENFORCED.
 * Here, the caller wants to BE the responder — a Claude Desktop session that
 * adopts the voice and house rules for a long stretch of work, using its own
 * model, without a server round-trip per turn.
 *
 * ⚠️ The difference is not cosmetic, and callers must be told: what leaves
 * this function is TEACHING, not PERMISSION. The composed prompt is the same
 * text the real turn uses, but nothing here can make a remote model obey it.
 * Specifically:
 *
 *   - `delegateTo` is a LIST, not a gate. The real loop refuses an
 *     `invoke_agent` call to an agent outside it (invoke-agent-guards);
 *     an outside caller holds no such gate.
 *   - `toolSlugs` is what the responder WOULD be granted. The caller's own
 *     MCP connector decides what it can actually call, and that set is
 *     usually WIDER, never narrower.
 *   - Confirm-gating, /pending parking, precondition checks, guards, hop
 *     limits and result-spill all live in the tool loop. None of them travel.
 *
 * So: use this to sound and reason like the responder. Use `runSimulatedResponderTurn`
 * when the rules must actually hold. The MCP descriptions say the same thing,
 * because a caller that misreads this will believe it is sandboxed when it is not.
 */

import { loadProfilePreferences } from '@mantle/content';
import { resolveAssistantAgent } from './run-turn';
import { assembleResponderTurn } from './assemble-turn';

export type DescribeResponderPersonaOptions = {
  /** Which responder to describe. Omit → the web-default responder. */
  agentSlug?: string;
  /** Describe the persona as it would be under a read-only turn, so the tool
   *  list matches what a read-only probe would actually get. */
  readOnly?: boolean;
};

export type ResponderPersonaDescription = {
  agent: { slug: string; name: string; model: string; provider: string };
  /** The composed system prompt: identity + persona + attached skills + house
   *  style. Byte-for-byte what a real turn puts in the cached prefix. */
  systemPrompt: string;
  /** Skills folded into that prompt, for a caller that wants to show its work. */
  skills: { slug: string; name: string }[];
  /** Tool slugs the responder WOULD hold this turn. Advisory: see the module
   *  note — the caller's own grants decide what it can really call. */
  toolSlugs: string[];
  /** Agents this responder may delegate to. Advisory, not a gate. */
  delegateTo: string[];
  /** True when `readOnly` narrowed `toolSlugs`. */
  readOnly: boolean;
  /** Plain-language warning, returned in-band so it lands in the caller's
   *  context next to the prompt it qualifies. */
  advisory: string;
};

const ADVISORY =
  'This is the persona as TEACHING, not as PERMISSION. The composed prompt is real, ' +
  'but nothing in this payload constrains you: `delegate_to` is a list rather than a ' +
  'gate, `tool_slugs` is what the responder would be granted rather than what you can ' +
  'call, and confirm-gating, /pending parking and the loop guards all stay on the ' +
  'server. Follow the prompt because you chose to. If the rules must actually be ' +
  'ENFORCED, use `ask_responder` instead and let the brain run the turn.';

/**
 * Resolve a responder and return its composed persona. Pure read: assembles the
 * same prompt a live turn would, runs no model, executes no tool, writes
 * nothing, and opens no trace.
 */
export async function describeResponderPersona(
  ownerId: string,
  opts: DescribeResponderPersonaOptions = {},
): Promise<ResponderPersonaDescription> {
  const agent = await resolveAssistantAgent(ownerId, opts.agentSlug);
  if (!agent) {
    throw new Error(
      'No enabled assistant agent. Create one at /settings/agents (role=assistant or fallback responder).',
    );
  }
  const prefs = await loadProfilePreferences(ownerId);
  const assembled = await assembleResponderTurn({
    ownerId,
    agent,
    prefs,
    logPrefix: '[mcp-persona]',
    ...(opts.readOnly ? { readOnly: true } : {}),
  });

  return {
    agent: {
      slug: agent.slug,
      name: agent.name,
      model: agent.model,
      provider: agent.provider,
    },
    systemPrompt: assembled.effectiveSystemPrompt,
    skills: assembled.attachedSkills.map((s) => ({ slug: s.slug, name: s.name })),
    toolSlugs: assembled.allowedTools.map((t) => t.slug).sort(),
    delegateTo: assembled.delegateTo,
    readOnly: opts.readOnly === true,
    advisory: ADVISORY,
  };
}
