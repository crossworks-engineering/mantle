/**
 * Build the synthetic "you have a heartbeat to act on right now" user
 * message. This is what Saskia sees on each fire — combining the
 * heartbeat's identity, current state, the skill's instructions, and
 * a short pointer at the control tools she can call to mutate state
 * or self-terminate.
 *
 * Note: we use ROLE='user' for this rather than ROLE='system' even
 * though it's system-generated. Reason: most LLM tool-loop wrappers
 * treat the latest user message as the "task to do". Slipping it in
 * as user keeps the model architecture's expectations aligned with
 * what we want behaviourally (act on this now).
 */

import type { Heartbeat, Skill } from '@mantle/db';

export function buildHeartbeatPrompt(args: {
  hb: Heartbeat;
  skill: Skill;
  /** Optional human-readable "Last fired: 2 days ago" preamble. */
  lastFiredHuman?: string;
}): string {
  const { hb, skill, lastFiredHuman } = args;
  const fireLine = lastFiredHuman
    ? `Fire #${hb.fireCount + 1}${hb.maxFires ? ` of ${hb.maxFires}` : ''}. Last fired: ${lastFiredHuman}.`
    : `Fire #${hb.fireCount + 1}${hb.maxFires ? ` of ${hb.maxFires}` : ''}. (First fire.)`;

  const stateBlock = JSON.stringify(hb.state ?? {}, null, 2);
  const skillBlock = skill.instructions.trim() || '(skill has no instructions)';

  return [
    `You have a standing heartbeat task to perform right now.`,
    ``,
    `Heartbeat: ${hb.slug} — ${hb.name}`,
    fireLine,
    ``,
    `Current state (your running memory for this heartbeat; mutate via heartbeat_update_state):`,
    '```json',
    stateBlock,
    '```',
    ``,
    `Skill instructions:`,
    skillBlock,
    ``,
    `Available heartbeat controls:`,
    `- heartbeat_update_state(patch): JSON-merge fields into the state above`,
    `- heartbeat_snooze(for_hours | until: iso): skip and reschedule politely`,
    `- heartbeat_complete(reason): stop firing this heartbeat permanently`,
    ``,
    `Compose your message to the user now. Be brief and match the conversational rhythm. ` +
      `If the skill says to wait for a reply, end your turn after sending one message — ` +
      `don't ask multiple questions at once.`,
  ].join('\n');
}

/**
 * Build the small awareness block that gets appended to the responder's
 * system prompt when there's an open heartbeat expecting a reply on
 * the current surface. Keeps Saskia in character across the
 * outbound/inbound boundary without exposing the heartbeat's full
 * skill instructions on every turn.
 */
export function buildOpenHeartbeatContext(open: Array<{
  slug: string;
  name: string;
  state: Record<string, unknown>;
}>): string {
  if (open.length === 0) return '';
  const lines = open.map((h) => {
    const stateSummary = JSON.stringify(h.state ?? {});
    return `- ${h.slug} (${h.name}): expecting a reply. Current state: ${stateSummary}`;
  });
  return [
    `## Open heartbeats`,
    ``,
    `You have one or more proactive tasks in-flight on this surface. ` +
      `The user's latest message may be replying to a question you asked. ` +
      `After responding naturally, call heartbeat_update_state with ` +
      `**\`slug\` set to the slug below** to capture what they told you ` +
      `and flip \`expecting_reply\` to false. Use heartbeat_complete (with ` +
      `the same \`slug\`) if the skill's goal is met.`,
    ``,
    ...lines,
  ].join('\n');
}
