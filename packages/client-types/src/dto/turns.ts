/**
 * @mantle/client-types · turns
 *
 * Live turn streaming and the ask_human questionnaire the runner queues raise.
 *
 * Split out of the 2548-line index.ts on 2026-09-02 (audit, tier 3) with the
 * contents unchanged. index.ts re-exports every one of these, so the package's
 * public surface is byte-identical — only the file a symbol lives in moved.
 */

// ── Live turn streaming ─────────────────────────────────────────────────────────

/**
 * The cross-client contract for live "what the agent is doing" updates during a
 * turn — consumed identically by the web client and the Flutter companion (see
 * `docs/live-turn-streaming.md`). One event stream unifies coarse status, tool
 * activity, reasoning, and token deltas.
 *
 * This is the wire shape ONLY (zero-runtime, per this package's invariant): the
 * server-side channel + publisher + schema-version constant live in
 * `@mantle/turn-stream`; the producer stamps `v`/`seq`/`round`.
 *
 * Evolution rule: new `type`s and new `data` fields are additive (non-breaking) —
 * a client ignores a `type` it doesn't recognise. A breaking change to an
 * existing event's shape bumps `v` (`TURN_EVENT_SCHEMA_VERSION`).
 */
export type TurnEventType =
  | 'turn-start'
  | 'status'
  | 'tool-start'
  | 'tool-end'
  | 'reasoning-delta'
  | 'text-delta'
  | 'done'
  | 'error';

/** A pending outbound message now exists; the client can bind UI to `turnId`. */
export interface TurnStartData {
  agentSlug: string;
  /** Resolved model id, when known at turn start (else null). */
  model: string | null;
  /** Durable `assistant_messages` id of the inbound (user) row, persisted before
   *  the model runs. Lets a client swap its optimistic user bubble for the
   *  canonical row without waiting on the POST. Optional (additive): a client
   *  that predates this field ignores it. */
  inboundId?: string;
  /** Durable `assistant_messages` id of the outbound (reply) row, inserted
   *  `pending` at turn start. This is the turn's authoritative reconciliation
   *  handle — the client binds the reply bubble to it and, on `done`, reads the
   *  final text from this row (vs. the advisory streamed buffer). Optional. */
  outboundId?: string;
}

/** A short "what it's doing now" line ("Searching your brain…"). `kind` is an
 *  optional coarse bucket the UI can theme/iconify. `stepId` ties together the
 *  grounded line and its later narrated upgrade for the SAME step, so the client
 *  replaces the line in place rather than appending a duplicate. */
export interface TurnStatusData {
  label: string;
  kind?: string;
  /** Stable id for the step this status describes. Two events sharing a stepId
   *  are the same step (grounded → narrated); the client upserts by it. */
  stepId?: string;
  /** Present (true) only on the narrator's rephrased line for a step — the warm
   *  first-person paragraph. Grounded lines omit it. Lets clients keep narrated
   *  text visible while later grounded lines tick past. */
  narrated?: true;
}

/** A tool round began. `summary` is an optional one-line, secret-free preview. */
export interface TurnToolStartData {
  name: string;
  summary?: string;
}

/** A tool round finished (`ok=false` = it errored — the turn may still recover). */
export interface TurnToolEndData {
  name: string;
  ok: boolean;
}

/** A chunk of the model's reasoning stream (raw; may be curated before display). */
export interface TurnReasoningDeltaData {
  text: string;
}

/** A chunk of the visible reply text. */
export interface TurnTextDeltaData {
  text: string;
}

/** Terminal success. The client now reconciles against the durable message row;
 *  the streamed text is advisory, the DB row is authoritative. */
export interface TurnDoneData {
  status: 'complete';
  /** Real output-token total for the whole turn (summed across rounds). The
   *  client shows a streamed char-based estimate while the reply types out, then
   *  swaps it for this exact figure on `done`. Optional + additive: absent when
   *  no provider reported usage, or from a producer that predates the field. */
  tokensOut?: number;
}

/** Terminal failure. */
export interface TurnErrorData {
  status: 'failed';
  message: string;
}

/** Fields every turn event carries. */
export interface TurnEventBase {
  /** Schema version (`TURN_EVENT_SCHEMA_VERSION` at emit time). */
  v: number;
  /** Durable turn id = the outbound `assistant_messages` id. Stable for the turn. */
  turnId: string;
  /** Monotonic per-turn sequence — the SSE `id:` field and the resume cursor. */
  seq: number;
  /** Tool-loop round this event belongs to (0 = before the first round). */
  round: number;
}

/** One live turn event. Discriminated on `type`; `data` is the matching payload. */
export type TurnEvent =
  | (TurnEventBase & { type: 'turn-start'; data: TurnStartData })
  | (TurnEventBase & { type: 'status'; data: TurnStatusData })
  | (TurnEventBase & { type: 'tool-start'; data: TurnToolStartData })
  | (TurnEventBase & { type: 'tool-end'; data: TurnToolEndData })
  | (TurnEventBase & { type: 'reasoning-delta'; data: TurnReasoningDeltaData })
  | (TurnEventBase & { type: 'text-delta'; data: TurnTextDeltaData })
  | (TurnEventBase & { type: 'done'; data: TurnDoneData })
  | (TurnEventBase & { type: 'error'; data: TurnErrorData });

// ── ask_human questionnaire (runner queues) ───────────────────────────────────
// THE single source of truth for the questionnaire contract. The plan parser
// (@mantle/tools) validates against these caps, the answer path (@mantle/runs)
// re-checks submissions against them, and the client renders whatever they
// admit. They lived in three places once and immediately disagreed — the
// client's id fallback diverged from the server's, and the client had no
// question cap while the API capped answers at 4, so a 5-question form
// rendered fine and then 400'd on submit.

/** One selectable answer. `description` is the muted subtext on the chip. */
export interface AskHumanFormOption {
  label: string;
  description?: string;
}

/** One sub-question of a questionnaire. `id` is the routing key answers are
 *  submitted under; `header` is the short chip shown beside the question. */
export interface AskHumanFormQuestion {
  id: string;
  header?: string;
  question: string;
  options: AskHumanFormOption[];
  multi_select?: boolean;
  /** Free-text escape. Defaults ON — a question whose options don't fit and
   *  offers no way to say so forces a wrong answer. */
  allow_other?: boolean;
}

export interface AskHumanForm {
  questions: AskHumanFormQuestion[];
}

/** One answered sub-question, as submitted to `PATCH /api/pending/:id` and
 *  `pending_approve`. `question` is the form question's `id`. */
export interface AskHumanFormAnswer {
  question: string;
  selected: string[];
  other?: string;
}

/**
 * Caps on a questionnaire. These are a CONTRACT, not advice: every answer
 * surface renders whatever the parser admits, so an unbounded form is an
 * unanswerable screen — and a cap enforced on only one side is a 400 the
 * operator can't act on.
 */
export const ASK_HUMAN_FORM_LIMITS = {
  /** Ask more than this and the answers to the first few probably change what
   *  you still need to ask — use a later `ask_human` step. */
  maxQuestions: 4,
  maxOptions: 8,
  /** A header renders as a chip, not a sentence. */
  maxHeaderChars: 24,
  maxQuestionChars: 300,
  maxLabelChars: 80,
  maxDescriptionChars: 200,
  maxOtherChars: 2_000,
  /** The form rides in `run_items.payload` AND the pending row's args, and
   *  both are read into prompts. */
  maxFormJsonBytes: 8_000,
} as const;
