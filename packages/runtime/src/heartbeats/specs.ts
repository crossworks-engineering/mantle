/**
 * The heartbeat control tools' definitions as data (A5 step 6d fix round 1):
 * each tool's slug, its `heartbeat` field, its policy, name, description
 * and input schema, with no handler and no runtime import, so a data module
 * that reads them (the system manifest's known external tools) loads none
 * of the heartbeat runtime. tools.ts adds each handler; HEARTBEAT_TOOLS
 * there is these, in this order.
 */
import type { BuiltinToolDef } from '@mantle/tools';

/** A heartbeat tool's definition, less its handler. */
export type HeartbeatToolSpec = Omit<BuiltinToolDef, 'handler'>;

/** Default cap on heartbeat_list output. The full state jsonb can
 *  be sizable for skills that accumulate (interview answers, daily
 *  log entries, …) — multiplied by N rows it'd blow context.
 *  P2-3 from the v1 audit. */
export const HEARTBEAT_LIST_DEFAULT_LIMIT = 20;
export const HEARTBEAT_LIST_MAX_LIMIT = 100;

export const HEARTBEAT_COMPLETE_SPEC: HeartbeatToolSpec = {
  slug: 'heartbeat_complete',
  heartbeat: { reaches: 'firing', responderOrder: 1 },
  policy: {
    effect: 'write',
    matrix: { none: 'a heartbeat is not an item' },
    spends: 'none',
    scope: 'any',
  },
  name: 'Mark a heartbeat complete',
  description:
    'Permanently stop a heartbeat. Use this when the skill has accomplished what it set out to do (e.g. all interview questions answered) OR when the user explicitly asks you to stop. Pass `slug` to target a specific heartbeat — required when called from a regular responder turn; optional inside a heartbeat fire (the firing one is the default). After this call, the heartbeat never fires again unless an operator re-activates it. Takes an optional `reason` string stored on the row for the operator to see.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'Heartbeat slug to complete. Required when not inside a heartbeat fire. Inside a fire, omit to default to the firing heartbeat.',
      },
      reason: {
        type: 'string',
        description:
          "Short free-text explanation of why the heartbeat is being completed, e.g. 'all topics covered' or 'user asked to stop'.",
      },
    },
  },
};

export const HEARTBEAT_SNOOZE_SPEC: HeartbeatToolSpec = {
  slug: 'heartbeat_snooze',
  heartbeat: { reaches: 'firing', responderOrder: 2 },
  policy: {
    effect: 'write',
    matrix: { none: 'a heartbeat is not an item' },
    spends: 'none',
    scope: 'any',
  },
  name: 'Snooze a heartbeat',
  description:
    "Push a heartbeat's next fire forward without completing it. Pass `slug` to target a specific heartbeat — required from a regular responder turn; optional inside a heartbeat fire (firing one is the default). Specify the delay via `for_hours` (e.g. 24 = try again tomorrow) or `until` (ISO-8601 instant). Useful when the user is busy or the moment isn't right but the heartbeat should keep trying.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'Heartbeat slug to snooze. Required when not inside a heartbeat fire.',
      },
      for_hours: { type: 'number', description: 'How many hours from now to defer.' },
      until: { type: 'string', description: 'ISO-8601 instant to defer until.' },
    },
  },
};

export const HEARTBEAT_UPDATE_STATE_SPEC: HeartbeatToolSpec = {
  slug: 'heartbeat_update_state',
  heartbeat: { reaches: 'firing', responderOrder: 0 },
  // A heartbeat's own scratch state, written on every fire: no audit row
  // inside a fire on the firing heartbeat (no `slug`). A call naming one by
  // slug (a responder turn must, and it may move another login's heartbeat
  // to this login) keeps its row (lows round, 6d L5).
  policy: {
    effect: 'write',
    matrix: { none: 'a heartbeat is not an item' },
    spends: 'none',
    scope: 'any',
    auditRow: { unlessArg: 'slug' },
  },
  name: "Update a heartbeat's state",
  description:
    "JSON-merge a `patch` object into a heartbeat's `state` jsonb. Top-level keys overwrite same-named keys in the existing state; other keys are preserved. Set a key to null to remove it. Pass `slug` to target a specific heartbeat — required from a regular responder turn (look at the 'Open heartbeats' block in your system prompt to find which slug to use); optional inside a heartbeat fire (firing one is the default). Use this to track progress (e.g. {answered: ['family'], expecting_reply: false}) so the next fire knows where the skill left off.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'Heartbeat slug whose state to update. Required when reacting to a user reply (responder turn). Inside a fire, omit to default to the firing one.',
      },
      patch: {
        type: 'object',
        description:
          'Object to merge into state. Top-level keys overwrite; nested objects are NOT deep-merged.',
      },
    },
    required: ['patch'],
  },
};

export const HEARTBEAT_LIST_SPEC: HeartbeatToolSpec = {
  slug: 'heartbeat_list',
  heartbeat: { reaches: 'every' },
  policy: {
    effect: 'write',
    matrix: { none: 'a heartbeat is not an item' },
    spends: 'none',
    scope: { area: 'assistants', systemWhole: true, adminOnly: true },
  },
  name: 'List the user heartbeats',
  description:
    "List the user's heartbeats with status, schedule, agent/skill slugs, and next-fire time. By default returns up to 20 rows with a SLIM projection (no state jsonb) — that's enough for the user-facing question 'what are you tracking for me?'. Pass `include_state: true` to get each heartbeat's full state (useful when the model needs to reason about progress). Pass `limit` to override (max 100). Pass `status` to filter.",
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'paused', 'completed', 'cancelled'],
        description: 'Filter to a single status. Omit for all.',
      },
      limit: {
        type: 'number',
        description: `Max rows to return. Default ${HEARTBEAT_LIST_DEFAULT_LIMIT}, hard cap ${HEARTBEAT_LIST_MAX_LIMIT}.`,
      },
      include_state: {
        type: 'boolean',
        description:
          "Include each heartbeat's full state jsonb. Off by default to keep the LLM's context lean — flip on when reasoning about progress / answered topics / etc.",
      },
    },
  },
};

export const HEARTBEAT_FIRE_SPEC: HeartbeatToolSpec = {
  slug: 'heartbeat_fire',
  heartbeat: { reaches: 'every' },
  policy: {
    effect: 'write',
    matrix: { none: 'a heartbeat is not an item' },
    spends: 'none',
    scope: { area: 'assistants', adminOnly: true },
  },
  name: 'Force-fire a heartbeat now',
  description:
    "Fire the heartbeat with the given slug RIGHT NOW, bypassing all gates (idle / quiet hours / cooldown). Used by the operator's 'Fire now' button and by skills that want to chain into another heartbeat. The fire still records to traces + heartbeat_fires with disposition='fired'. Does NOT need to be inside an existing heartbeat fire. Cannot fire the heartbeat that is currently calling this tool (direct self-recursion is refused), and chained fires are capped at MAX_HEARTBEAT_DEPTH to prevent runaway loops. Only the user who set up the heartbeat may fire it.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'The heartbeat slug to fire.' },
    },
    required: ['slug'],
  },
};

/** The five, in HEARTBEAT_TOOLS' order (tools.ts). */
export const HEARTBEAT_TOOL_SPECS: readonly HeartbeatToolSpec[] = [
  HEARTBEAT_COMPLETE_SPEC,
  HEARTBEAT_SNOOZE_SPEC,
  HEARTBEAT_UPDATE_STATE_SPEC,
  HEARTBEAT_LIST_SPEC,
  HEARTBEAT_FIRE_SPEC,
];
