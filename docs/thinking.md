# Thinking: profile setting and per-agent effort

How much an agent reasons before it answers, and who decides.

## Two settings, two owners

| Setting                                                            | Where                        | Owner      | What it controls                                                                  |
| ------------------------------------------------------------------ | ---------------------------- | ---------- | --------------------------------------------------------------------------------- |
| **Live thinking & streaming** (`streamThoughts`, `thinkingBudget`) | Settings, Profile            | the person | whether they watch the thought trail, and the effort an agent on **Inherit** uses |
| **Thinking effort** (`agents.thinking_effort`, migration 0228)     | Settings, Agents (one agent) | the agent  | the effort THIS agent uses, whatever the profile says                             |

The effort tiers are `low`, `medium`, `high`, `xhigh`, `max`
(`THINKING_EFFORTS` in `packages/content-core/src/thinking-tiers.ts`). The
profile dropdown offers Off to High (`THINKING_TIERS`); an agent may also take
the two upper rungs (`AGENT_THINKING_EFFORTS`). New installs start the profile
at Medium.

## Precedence

One rule, in `applyAgentThinking` / `resolveAgentThinking`
(`packages/content-core/src/profile-projections.ts`), used by every turn path:

1. The agent has its own effort: use it. `off` = no reasoning.
2. The agent is on **Inherit** (NULL): use the person's profile. This is the
   behaviour from before the column existed, unchanged: reasoning only when the
   live-thinking switch is on AND the budget is above 0.
3. Nothing set: no reasoning.

| Agent   | Profile            | Result |
| ------- | ------------------ | ------ |
| Inherit | Medium, switch on  | medium |
| Inherit | Off, or switch off | none   |
| Off     | anything           | none   |
| High    | Off, or switch off | high   |

### Why the switch does not gate an agent's own effort

The live-thinking switch is about what a person likes to WATCH. An agent's
effort is a property of the agent: an owner who sets High on a research agent
wants it to reason, whether or not they watch the trail. So for an agent with
its own effort, the switch controls display only. For an agent on Inherit the
switch still gates reasoning, exactly as before, so a person who turned the
switch off still pays for no reasoning on those agents.

## Per path

| Path                                                      | Inherit                                                           | Own effort                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Web, Telegram, MCP sim, resumed runs (`assemble-turn.ts`) | profile budget + effort                                           | applies                                                  |
| Team and client turns (`withThinking: false`)             | none (the profile is the owner's, not the caller's)               | applies (set on the team or client responder on purpose) |
| Delegated agent (`invoke-agent.ts`)                       | the profile budget the caller forwards, no effort (the old shape) | applies                                                  |
| Heartbeat fire (`heartbeats/fire.ts`)                     | profile budget, no effort (the old shape)                         | applies                                                  |
| Run worker (`runs-worker-turn.ts`)                        | none (never had thinking)                                         | applies                                                  |
| AI workers (extractor, summarizer, reflector)             | not agents rows: no thinking, unchanged                           | n/a                                                      |

A delegated agent on Inherit receives the PROFILE budget, not the calling
agent's own effort (`inheritThinkingBudget` on `runToolLoop`). Only the budget
travels, never the effort, as before. On OpenRouter (which reads the effort
only) a delegate or heartbeat on Inherit therefore does not reason; give the
agent its own effort when it should.

## Model support

The effort is sent only when the model supports it. The adapters drop or
downgrade a tier a model lacks (`anthropicEffort` in
`packages/voice/src/adapters/anthropic-chat.ts`: no `xhigh` on some models,
`max` becomes `high` on others, none at all on the oldest). OpenRouter passes
the effort as `reasoning.effort`; a model that ignores it simply does not
reason. The budget behind each tier (`thinkingBudgetForEffort`) sizes the
max_tokens headroom and is clamped against the agent's own `max_tokens`.

## Editing it

- The agent settings screen (jackdaw): the "Thinking effort" select.
- `PATCH /api/agents/:id` with `thinkingEffort` (`null` = Inherit).
- The `agent_set_thinking_effort` tool (Toolsmith group, MCP). An agent cannot
  change its own effort, and another agent asking waits at /pending for the
  operator. `agent_list` shows each agent's effort.
- Shipped agents (the system manifest) start on Inherit, and the boot reconcile
  never touches the column: the effort is the owner's choice.

## Cost safety

Every existing agent reads NULL after migration 0228, so nothing changes until
someone sets an effort on an agent. Inherit equals the old behaviour on every
path, including "profile at Off sends no reasoning".
