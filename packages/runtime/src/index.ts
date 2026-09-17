/**
 * @mantle/runtime — the agent execution layer, in one package.
 *
 * Three packages until tier 3 of the 2026-09-02 audit: @mantle/agent-runtime
 * (the low-level tool loop), @mantle/heartbeats (scheduled self-invocation)
 * and @mantle/assistant-runtime (a whole conversational turn). The split was
 * never a boundary anyone chose — it was a dependency ORDER, agent <- heartbeats
 * <- assistant, written down as package edges. assistant-runtime's own header
 * said so: it lived outside agent-runtime "because a turn needs heartbeats, and
 * heartbeats already depends on agent-runtime". Three package.jsons, three
 * tsconfigs and 23 cross-package import lines to express "these files load in
 * this order", which is what a module graph does for free.
 *
 * The subdirectories keep the order visible without charging for it:
 *   agent/      the tool loop, chat routing, message assembly
 *   heartbeats/ schedules, gates, firing (imports agent/)
 *   assistant/  full turns across chat, forum, team, sim (imports both)
 *
 * Each layer keeps its own entry point — @mantle/runtime/agent,
 * /heartbeats, /assistant — so an import site says which layer it reaches for
 * and a test can still mock ONE layer while running the others for real. That
 * granularity is not cosmetic: telegram-turn.test.ts mocks the tool-loop seams
 * and deliberately runs the REAL turn assembly, which a single barrel mock
 * would blank out. This barrel re-exports all three (145 names, no collisions)
 * for callers that want the whole surface.
 */

export * from './agent';
export * from './heartbeats';
export * from './assistant';
