/**
 * @mantle/runtime — the agent execution layer, in one package.
 *
 * The tool loop, heartbeats (scheduled self-invocation) and a whole
 * conversational turn are one package, not three: what separates them is a
 * dependency ORDER, agent <- heartbeats <- assistant, not a boundary, and a
 * module graph expresses "these files load in this order" for free.
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
