# Tool reliability — how a tool call is validated, guarded, and reported

Shipped in v0.119.0. This is the architecture + ops reference for the tool
reliability layer: what happens to every tool call between "the model asked
for it" and "the model reads the result", which knobs exist, and how to roll
enforcement out. The design principle behind all of it:

> **Prose → schema → validating errors → gates → code.**
> Every rule a model can ignore is moved down the ladder until it can't be:
> either the mistake becomes unrepresentable (schema enums, atomic batch
> tools), or it fails loudly with an error that teaches the fix (so the model
> self-corrects in one retry), or a gate stops it (guards, approval). Prose
> guidance remains only where nothing stronger can express the rule.

A second principle governs everything that touches retrieved content:

> **Mutate diagnostics, never data.** Error strings are runtime diagnostics —
> they get aggressively sanitized. Fenced retrieved content is the user's
> data — it is NEVER rewritten; the fence boundary is the defense, and only
> forged fence markers are defanged. A sanitizer that edits fenced content
> would silently corrupt legitimate documents.

## The per-call pipeline

Every tool call in a turn passes through these stages, in order
(`packages/agent-runtime/src/tool-loop.ts`):

1. **In-response dedup** — byte-identical `tool_use` blocks within one model
   response are suppressed after the first (write-amplification guard).
   Deliberately byte-exact; everything outcome-related below uses canonical
   signatures instead.
2. **Volume caps** (batch-atomic, per-agent overridable) — 20 calls/response,
   40/turn, 15/tool-per-turn; a batch that starts under its caps completes in
   full. See v0.118.0.
3. **Parse** — malformed JSON args never reach a handler; the model gets a
   corrective error.
4. **Coerce-then-validate** (`packages/tools/src/validate-args.ts`) — args are
   checked against the tool's own `inputSchema`. Safe repairs are applied
   first (`"42"`→`42`, `"true"`→`true`, scalar→`[scalar]` for array params,
   stringified JSON parsed, `null` dropped from optional params); what
   survives is validated (required / type / enum / range / unknown keys).
   Violations produce **teaching errors** — field, expected vs got, the
   recovery move, and a did-you-mean on enum/key near-misses.
5. **Failure-aware guards** — keyed by *canonical* signature (post-repair
   args, sorted keys), so encoding drift can't evade them:
   - the same call failing repeatedly: the error payload teaches from the
     2nd failure; the 6th attempt is blocked (`repeated_failure`);
   - the same call returning a byte-identical result 5 times: the 6th is
     blocked (`no_progress`). A changed result resets the streak, so
     re-reads after writes are never penalised.
6. **Allowlist** — the tool must be in the agent's resolved tool-group union
   (checked per call, not just at prompt assembly).
7. **Enforcement** — in `enforce` mode (see below), schema violations from
   stage 4 block dispatch here.
8. **Approval gate** — `requires_confirm` tools are parked in
   `pending_tool_calls` for the operator; the model is told the action is
   queued, and the outcome ledger reports it as *queued*, never done.
9. **Preconditions** (`packages/tools/src/preconditions.ts`) — declarative
   referential checks on the tool def (`{ kind: 'node_exists', param,
   nodeType, lookup }`): malformed id, missing node, and **wrong node type**
   ("id … is a note, not a page") each get a uniform teaching error before
   the handler runs.
10. **Handler** — the tool's own logic; its checks remain as backstops.
11. **Result hygiene** — errors run through `sanitizeToolError` (role tags,
    `[system]`-style bracket markers, code fences, CDATA stripped; 2 KB cap).
    Successful results carrying third-party content are **fenced by
    provenance**: the web builtins by slug, and anything the dispatch layer
    flagged `untrusted` — every http-kind tool result, and any recipe whose
    chain ran an http/web step. Fencing happens before the inline/spill
    decision, so `read_result` pages are fenced too.
12. **Ledger** — every call lands in the turn's `ToolCallRecord` list. When a
    turn is ended by budget or iteration cap, the model is handed the
    runtime's own tally ("17 issued — 14 succeeded, 2 FAILED, 1 queued for
    operator approval…") before composing its final answer, and the same
    stats persist onto the outbound message: the /assistant footer shows
    "N tool calls", with an always-visible notice when any failed.

## Ops: `MANTLE_TOOL_VALIDATION`

| Mode | Coercion | Violations | Use |
|---|---|---|---|
| `off` | none | ignored | escape hatch only |
| `warn` *(default)* | applied | **telemetry only** — logged, still dispatched | rollout / observation |
| `enforce` | applied | **block dispatch** with the teaching error | steady state, per box |

Rollout playbook: leave the box on `warn` (the default — no env change
needed), let real traffic accumulate, then inspect
`trace_steps.meta.arg_validation` (repairs, unknown keys, violations, per
tool). When the violation profile looks like model mistakes rather than
schema bugs, set `MANTLE_TOOL_VALIDATION=enforce` in the stack `.env` and
restart. Coercion repairs and unknown-key telemetry are recorded in every
mode, so the data collects itself.

Builtins' top-level schemas are closed (`additionalProperties: false`) at
seed time — `closeToolInputSchema` in `packages/tools/src/seed.ts`. Dynamic-
key inputs live in nested props that declare their own `additionalProperties`
(table cells, app files). User-authored http/recipe tool schemas are never
closed automatically.

## Approval gates (`requires_confirm`)

Gated by default since v0.119.0: `email_send`, `email_page`, `page_share`,
`contact_delete` (joining `telegram_send` and the whole-entity deletes).
The seed sets the flag **on insert only** and never re-asserts it on
existing rows — operator overrides are sacred. Existing brains keep their
current behaviour; tighten per tool in Settings → Tools if wanted.
`run_terminal` (grant-gated power capability) and `app_publish` (the
draft/commit ritual is the oversight) deliberately stay open.

## Extending the layer

- **New tool** — write real schema constraints (enum/min/max/required), not
  prose; follow the error style guide in `packages/tools/CLAUDE.md` (every
  `ok:false` answers "what do I do instead"; use `notFound()` for missing
  ids). Add `preconditions` for every node-id param. If the tool returns
  third-party bytes outside the http path, add its slug to
  `UNTRUSTED_CONTENT_TOOL_SLUGS`.
- **Dynamic schema** — `registerDynamicSchema(slug, fn)`
  (`packages/tools/src/dynamic-schema.ts`) rebuilds a tool's model-facing
  schema/description against current reality once per turn (`invoke_agent`'s
  delegate enum is the reference consumer). Hooks fail open to the static
  schema.
- **Multi-block page edits** — `page_blocks_apply` applies up to 50 ordered
  block ops atomically (one draft save, all-or-nothing, failing op index
  named). The strategy ladder in the pages skill: one-off fix → single block
  tools; 3–50 targeted edits → ONE batch; full restructure → ONE
  `page_update_draft`.

## Provenance & lineage

Designed from the 2026-07-07 tool-reliability audit (dev-brain journals
`6d473b7f`, `e40bbc4e`) with four patterns adapted from the hermes-agent
reference clone (coerce-then-validate, failure-aware guards, dynamic schema
overrides, error sanitization). Post-build adversarial review fixed three
defects before release (`a8c38e84`): the queued-as-succeeded ledger bug,
raw-byte guard signatures, and the `[system]` bracket-marker sanitizer gap.
