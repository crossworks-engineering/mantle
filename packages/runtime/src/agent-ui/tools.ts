/**
 * The agent UI tools (docs/agent-ui.md): an in-app agent drives the window
 * the person chats from. Seven builtins, `ui_<action>`, each one call on the
 * window and its answer:
 *
 *   1. the tool opens a `ui_calls` row (openUiCall, keyed on the turn and the
 *      tool call's id, so a DBOS re-run of the step finds it again);
 *   2. it emits a `ui-call` event on the turn's stream (emitTurnUiCall:
 *      ordered and buffered with the rest of the turn);
 *   3. the window acts and answers POST /api/assistant/turn/:turnId/ui/:callId;
 *   4. the tool waits for the row (wait.ts) until it is answered, the turn is
 *      stopped (`stopped`) or the call expires (`window_gone`).
 *
 * Offered only on a turn that named its window, streams, and whose login
 * turned the setting on (an owner turn, run-turn.ts, or a member's workspace
 * turn, run-team-turn.ts; assemble-turn.ts agentUiTools): a per-turn
 * affordance like the heartbeat continuity tools, never a stored grant, so
 * no tool group names them, and never on the MCP surface (they are
 * registered in the runner's process only, as the heartbeat tools are). The
 * window, not the tool, decides what an action may touch; the brain refuses
 * an agent-driven delete, send, share, publish, tree move or settings change
 * whatever the window did (the `x-mantle-agent-call` header, server/web
 * lib/auth/agent-call.ts: 403 `agent_refused`), and the window holds it for
 * the person.
 *
 * The trace keeps the action and its outcome only, on both engines: the
 * tool step its slug and ok or the error code (`traceCodeOnly`), the
 * `ui_action` step under it the action and ok or the error code. Never a
 * target's name, a caption, an option, a path, typed text or the screen.
 *
 * A call's row is keyed on the turn and the tool call's id. A provider that
 * sends no id gets a fallback one from its adapter, and a provider may
 * repeat its own ids; so within a turn a repeated id is made unique
 * (UiStepKeys), and two calls never share a row.
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_UI_CALL_TTL_MS,
  type AgentUiAction,
  type AgentUiError,
} from '@mantle/client-types/agent-ui';
import { expireTurnUiCalls, openUiCall, readUiCall } from '@mantle/db';
import { currentTrace, currentTurnAbortSignal, emitTurnUiCall, step } from '@mantle/tracing';
import {
  registerBuiltin,
  type BuiltinToolDef,
  type ToolHandlerContext,
  type ToolHandlerResult,
  type ToolPolicy,
} from '@mantle/tools';
import { errorCodeOf } from '@mantle/tools/trace-shape';
import { pauseForUiCall, waitForUiAnswer, type UiWaitDeps } from './wait';
import { AGENT_UI_TOOL_SLUGS } from './slugs';
import { UI_BUDGET_ERROR, uiTeamBudget, type UiBudget } from './budget';

/** The largest `args` a call sends the window, as JSON bytes: the event
 *  rides one NOTIFY (about 8 KB with its envelope). */
export const UI_ARGS_MAX_BYTES = 6000;

/** One policy for all seven: a write (it may change what the window shows
 *  and, through it, what the person's pages do), no item of its own, no
 *  spend. Never in a recipe or a run item (no window there), never in a
 *  team app. Its results are fenced as data before the model reads them
 *  (`outside.untrusted`): a screen shows text other people wrote. They are
 *  private output too (PRIVATE_OUTPUT_TOOL_SLUGS: never journaled or
 *  spilled, a team reply that used one is marked used_private). */
const UI_POLICY: ToolPolicy = {
  effect: 'write',
  outside: { untrusted: true },
  matrix: { none: "it acts in the person's own window, not on an item" },
  spends: 'none',
  scope: 'any',
  recipe: { step: 'forbidden', runItem: 'banned' },
  memberApp: 'refused',
  clientSourced: {
    kind: 'free',
    why: "it acts in the person's own window only, with that person's rights: every request the window makes for it is tagged, and the brain refuses a tagged delete, send, share, publish, tree move, settings change, Admin-only write or body with a sharing field (server/web lib/auth/agent-call.ts), which the window holds for the person to allow",
  },
};

const TARGET_SCHEMA = {
  type: 'object',
  description:
    'The element: `{ref}` from the last `ui_screen` (preferred), or `{id}`, or `{role, name}` (e.g. {"role":"button","name":"Save"}).',
  properties: {
    ref: { type: 'string', maxLength: 64 },
    id: { type: 'string', maxLength: 200 },
    role: { type: 'string', maxLength: 64 },
    name: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
} as const;

type Spec = {
  action: AgentUiAction;
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  redact?: string[];
};

const SPECS: readonly Spec[] = [
  {
    action: 'screen',
    name: "Read the person's window",
    description:
      "Read what the person's window shows now: its route, title and an outline of its controls, each with a `ref` the other `ui_*` tools take. Call it first and after each navigation. Reads the window only; for the brain's own data use the read tools (search, `node_read`).",
    properties: {},
  },
  {
    action: 'navigate',
    name: "Open a page in the person's window",
    description:
      "Open an in-app route in the person's window (e.g. /pages or /files). The window refuses a route outside the app (`bad_route`). Use it to show the person where something is; to read data, use the read tools instead.",
    properties: {
      path: {
        type: 'string',
        description: 'The in-app route, e.g. "/settings/profile".',
        pattern: '^/',
        maxLength: 500,
      },
    },
    required: ['path'],
  },
  {
    action: 'click',
    name: "Click in the person's window",
    description:
      "Click one control in the person's window. A delete, send, share, publish or settings change is refused (`needs_user`): ask the person to click it, and use `ui_point` to show them where. Returns the screen change in brief.",
    properties: { target: TARGET_SCHEMA },
    required: ['target'],
  },
  {
    action: 'type',
    name: "Type in the person's window",
    description:
      "Type text into one field of the person's window. It is added at the end of what the field already holds; set `replace: true` only to clear the field and type in its place. A password or secret field is refused (`secret_field`): ask the person to fill it. To change the brain's data directly, use its write tools instead.",
    properties: {
      target: TARGET_SCHEMA,
      text: {
        type: 'string',
        description: 'What to type, added at the end of the field.',
        maxLength: 2000,
      },
      replace: {
        type: 'boolean',
        description:
          'true: clear the field first, and the text takes its place. Leave it out (or false) to append.',
      },
    },
    required: ['target', 'text'],
    redact: ['text'],
  },
  {
    action: 'select',
    name: "Choose an option in the person's window",
    description:
      "Choose one option of a select, menu or radio group in the person's window, by its visible label.",
    properties: {
      target: TARGET_SCHEMA,
      option: { type: 'string', description: 'The option\'s label, e.g. "Dark".', maxLength: 200 },
    },
    required: ['target', 'option'],
  },
  {
    action: 'point',
    name: "Point something out in the person's window",
    description:
      "Highlight one element of the person's window with a short caption, without clicking it. Use it to show the person a control they must press themselves (a delete, a send, a share).",
    properties: {
      target: TARGET_SCHEMA,
      caption: { type: 'string', description: 'A few words beside the highlight.', maxLength: 200 },
    },
    required: ['target', 'caption'],
  },
  {
    action: 'wait',
    name: "Wait for the person's window",
    description:
      "Wait until an element appears in the person's window, or for `ms` milliseconds, e.g. after a click that loads a page. Returns `timeout` when it did not appear.",
    properties: {
      target: TARGET_SCHEMA,
      ms: { type: 'integer', description: 'How long to wait at most.', minimum: 0, maximum: 10000 },
    },
  },
];

/** The `ui_action` trace step's input: the action only. Never a target's
 *  name, a caption, an option, a path or typed text: each can name what the
 *  person's window shows. */
export function traceInput(action: AgentUiAction): { action: AgentUiAction } {
  return { action };
}

/** The arguments the window is sent: `ui_type` always says whether it
 *  replaces (append unless the model asked `replace: true`). */
export function windowArgs(
  action: AgentUiAction,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return action === 'type' ? { ...args, replace: args.replace === true } : args;
}

/**
 * The step keys a turn's ui calls used, in this process: a tool call id
 * seen again in the same turn (a provider's fallback `call_<name>`, or a
 * provider that repeats its ids) gets `#2`, `#3`, ..., so each call has a row
 * of its own and acts. A DBOS re-run of the turn (a new process) counts
 * again from the start, in the same order, so it finds the same rows. An
 * entry no call touched for an hour is dropped.
 */
export class UiStepKeys {
  private readonly turns = new Map<string, { seen: Map<string, number>; touchedAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The step key of the next call of `turnId` with tool call id `callId`. */
  next(turnId: string, callId: string): string {
    const t = this.now();
    for (const [id, e] of this.turns) if (t - e.touchedAt > 60 * 60_000) this.turns.delete(id);
    let e = this.turns.get(turnId);
    if (!e) {
      e = { seen: new Map(), touchedAt: t };
      this.turns.set(turnId, e);
    }
    e.touchedAt = t;
    const n = (e.seen.get(callId) ?? 0) + 1;
    e.seen.set(callId, n);
    return n === 1 ? `${turnId}:${callId}` : `${turnId}:${callId}#${n}`;
  }
}

/** The runner's step keys. */
export const uiStepKeys = new UiStepKeys();

/** Why a target is not one the window takes, or null. */
function targetProblem(target: unknown, required: boolean): string | null {
  if (target === undefined) return required ? 'target is required' : null;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return 'target must be an object';
  }
  const t = target as Record<string, unknown>;
  const ways = [typeof t.ref === 'string', typeof t.id === 'string', typeof t.role === 'string'];
  if (ways.filter(Boolean).length !== 1) {
    return 'target names one element one way: {ref}, {id} or {role, name}';
  }
  if (typeof t.role === 'string' && typeof t.name !== 'string') {
    return 'a {role} target needs its name too: {role, name}';
  }
  return null;
}

/** The tool failure for a window error code, worded for the model. */
function uiFailure(error: AgentUiError | string, message: string): ToolHandlerResult {
  return { ok: false, error: `${error}: ${message}` };
}

/** The ui call this turn may make: its turn, login and window, or why not. */
export function uiCallContext(
  ctx: ToolHandlerContext,
  turnId: string | null | undefined,
): { turnId: string; loginId: string; windowId: string } | null {
  const s = ctx.surface;
  // An Admin user's chat (web) or a member's workspace turn (team): the
  // login and the window the runtime set, never the model.
  if (s?.kind !== 'web' && s?.kind !== 'team') return null;
  if (!s.uiWindowId || !s.loginId || !turnId) return null;
  return { turnId, loginId: s.loginId, windowId: s.uiWindowId };
}

/** What a call needs beyond its arguments, injectable for tests. */
export type UiCallDeps = {
  open: typeof openUiCall;
  emit: typeof emitTurnUiCall;
  wait: UiWaitDeps;
  turnId: () => string | null | undefined;
  signal: () => AbortSignal | undefined;
  /** A member's workspace turn's ui budget (budget.ts). */
  budget: Pick<UiBudget, 'take' | 'waited'>;
  /** Give up a turn's open calls (its budget ran out mid-wait). */
  expire: typeof expireTurnUiCalls;
  /** The turn's step keys (a repeated tool call id gets its own). */
  keys: Pick<UiStepKeys, 'next'>;
};

// Read at the call, not at load: a module that loads these tools (the runner's
// boot) may stand the database or the tracer in without them.
const defaultDeps: UiCallDeps = {
  open: (c) => openUiCall(c),
  emit: (turnId, ownerId, data) => emitTurnUiCall(turnId, ownerId, data),
  wait: { read: (id) => readUiCall(id), now: () => Date.now(), pause: pauseForUiCall },
  turnId: () => currentTrace()?.turnId,
  signal: () => currentTurnAbortSignal(),
  budget: uiTeamBudget,
  expire: (p) => expireTurnUiCalls(p),
  keys: uiStepKeys,
};

/** One ui call: open its row, ask the window, wait for the answer. */
export async function runUiCall(
  action: AgentUiAction,
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: UiCallDeps = defaultDeps,
): Promise<ToolHandlerResult> {
  const call = uiCallContext(ctx, deps.turnId());
  if (!call) {
    return uiFailure(
      'no_session',
      "this turn has no window to act in (the person's agent UI setting is off, or the chat is not live). Answer in text instead.",
    );
  }
  const needsTarget = action !== 'screen' && action !== 'navigate' && action !== 'wait';
  const bad =
    action === 'screen' || action === 'navigate' ? null : targetProblem(args.target, needsTarget);
  if (bad) return uiFailure('bad_target', `${bad}. Take a ref from \`ui_screen\` and call again.`);
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > UI_ARGS_MAX_BYTES) {
    return uiFailure(
      'too_long',
      `the arguments are too long for one call (over ${UI_ARGS_MAX_BYTES} bytes): split the text over several calls.`,
    );
  }

  // A member's workspace turn holds a slot of the member turn queue while
  // it waits: its ui calls have a budget (budget.ts). Past it, at once.
  const team = ctx.surface?.kind === 'team';
  const allowance = team ? deps.budget.take(call.turnId) : null;
  if (team && allowance === null) return { ok: false, error: UI_BUDGET_ERROR };

  const stepKey = deps.keys.next(call.turnId, ctx.toolCallId ?? randomUUID());
  const { row, created } = await deps.open({
    ...call,
    stepKey,
    action,
    ttlMs: AGENT_UI_CALL_TTL_MS,
  });
  if (created) {
    const reached = deps.emit(call.turnId, ctx.ownerId, {
      callId: row.id,
      action,
      args: windowArgs(action, args),
      expiresAt: row.expiresAt.toISOString(),
    });
    if (!reached) {
      return uiFailure(
        'no_session',
        'no live stream reaches the window here. Answer in text instead.',
      );
    }
  }
  // A new call waits its TTL on this process's clock (the row's expires_at
  // is the database's, which the answer is held to); a re-run of the step
  // waits what the row has left.
  const started = deps.wait.now();
  const due = created ? started + AGENT_UI_CALL_TTL_MS : row.expiresAt.getTime();
  // A team turn waits no longer than its budget has left.
  const capped = allowance !== null && due - started > allowance;
  const deadline = capped ? started + allowance : due;
  const out = await waitForUiAnswer(row.id, deadline, deps.wait, deps.signal());
  if (team) deps.budget.waited(call.turnId, deps.wait.now() - started);
  if (capped && out.kind === 'window_gone') {
    // The budget ran out mid-wait: the turn makes no more calls, so its open
    // ones are given up (a late answer changes nothing).
    await deps.expire({ turnId: call.turnId, loginId: call.loginId }).catch(() => 0);
    return { ok: false, error: UI_BUDGET_ERROR };
  }
  if (out.kind === 'stopped')
    return uiFailure('stopped', 'the person stopped the turn. Stop acting.');
  if (out.kind === 'window_gone') {
    return uiFailure(
      'window_gone',
      'the window did not answer in time (it may be closed or asleep). Tell the person and go on in text.',
    );
  }
  const r = out.result;
  if (r.ok === true) return { ok: true, output: r };
  const code = typeof r.error === 'string' ? r.error : 'unsupported';
  const message = typeof r.message === 'string' ? r.message.slice(0, 500) : 'the window refused it';
  return uiFailure(code, message);
}

/** The ui call under its `ui_action` trace step. */
async function tracedUiCall(
  action: AgentUiAction,
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolHandlerResult> {
  return step(
    {
      name: `ui: ${action}`,
      kind: 'ui_action',
      input: traceInput(action),
      // Its result is the window's (private output): never journaled, as
      // the tool step around it is not.
      durable: false,
    },
    async (h) => {
      const res = await runUiCall(action, args, ctx);
      if (res.ok) h.setOutput({ ok: true });
      else {
        const code = errorCodeOf(res.error);
        h.setOutput({ ok: false, error: code });
        h.setError(code);
      }
      return res;
    },
  );
}

if (SPECS.map((s) => `ui_${s.action}`).join() !== AGENT_UI_TOOL_SLUGS.join()) {
  throw new Error('agent-ui: the tool specs and AGENT_UI_TOOL_SLUGS differ');
}

/** The seven definitions. */
export const AGENT_UI_TOOLS: readonly BuiltinToolDef[] = SPECS.map((s) => ({
  slug: `ui_${s.action}`,
  name: s.name,
  description: s.description,
  inputSchema: {
    type: 'object',
    properties: s.properties,
    ...(s.required ? { required: s.required } : {}),
  },
  policy: UI_POLICY,
  // The tool step keeps its slug and outcome code only; the redaction is
  // for any other log of the arguments.
  traceCodeOnly: true as const,
  ...(s.redact ? { redactInputFields: s.redact } : {}),
  handler: (input, ctx) => tracedUiCall(s.action, input, ctx),
}));

/** Register the ui tools with the builtin registry: in the runner's process
 *  (server/api), before seedBuiltinTools, as the heartbeat tools are.
 *  Idempotent. */
export function registerAgentUiTools(): void {
  for (const def of AGENT_UI_TOOLS) registerBuiltin(def);
}
