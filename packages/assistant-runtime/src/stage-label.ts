/**
 * Map a trace-step `name` (+ optional input args) to a short, grounded status
 * label — the live "what is the agent doing right now" line.
 *
 * Shared by the producer (apps/api, which publishes `status` events as steps
 * start) and the web poll fallback (apps/web/lib/assistant/turn-stage.ts) so both
 * speak with one voice. Granularity is deliberately coarse — a handful of stages
 * a user actually waits on (thinking, searching, delegating). When the step's
 * input carries a safe, query-ish field we enrich the label with it
 * ("Searching your brain for “Pinnacle SLA”…"); otherwise we use the bucket.
 *
 * Step names come from the tool loop (packages/agent-runtime/src/tool-loop.ts):
 *   - `<adapter>_chat`, `..._chat[2]`, `..._chat[force_final]` → an LLM call
 *   - `tool: <slug>`          → a tool dispatch (bucketed by slug)
 *   - `spill_result: <slug>`  → result paging
 */

export interface StageLabel {
  /** User-facing line ("Searching your brain for “Pinnacle SLA”…"). */
  label: string;
  /** Coarse bucket the UI can theme/iconify. */
  kind: 'thinking' | 'web' | 'brain' | 'delegate' | 'tool';
}

/** Keys whose name alone marks a value as secret — never echoed into a label. */
const SENSITIVE = /secret|token|password|passwd|api[-_]?key|auth|bearer|credential/i;

/** Pull the first safe, non-empty string under one of `keys`, trimmed + capped.
 *  Only named keys are ever surfaced, so arbitrary/secret args can't leak into a
 *  status line. */
function pickString(
  input: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | null {
  if (!input) return null;
  for (const k of keys) {
    if (SENSITIVE.test(k)) continue;
    const v = input[k];
    if (typeof v !== 'string') continue;
    const s = v.trim().replace(/\s+/g, ' ');
    if (!s) continue;
    return s.length > 48 ? `${s.slice(0, 47)}…` : s;
  }
  return null;
}

/** Query-ish fields a search/recall tool puts the user's intent under. */
const QUERY_KEYS = ['query', 'q', 'search', 'term', 'text', 'question', 'title'] as const;
/** Where invoke_agent carries the specialist it's delegating to. */
const AGENT_KEYS = ['agent', 'agent_slug', 'slug', 'name', 'target'] as const;

/** A tool step logs its input as `{ slug, args }`; the user-facing values live
 *  under `args`. Unwrap it (falling back to the object itself for any flat
 *  caller) so enrichment reads `args.q`, not a non-existent top-level `q`. */
function toolArgs(input?: Record<string, unknown>): Record<string, unknown> | undefined {
  const a = input?.args;
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : input;
}

export function stageLabelForStep(
  name: string,
  input?: Record<string, unknown>,
): StageLabel | null {
  if (!name) return null;
  // LLM calls: the adapter step name always ends in `_chat` or `_chat[…]`.
  if (/_chat(\[|$)/.test(name)) return { label: 'Thinking…', kind: 'thinking' };

  const tool = /^tool:\s*(.+)$/.exec(name);
  if (tool) {
    const slug = tool[1]!.trim();
    const args = toolArgs(input);
    if (slug === 'invoke_agent') {
      const who = pickString(args, AGENT_KEYS);
      return {
        label: who ? `Delegating to ${who}…` : 'Delegating to a specialist…',
        kind: 'delegate',
      };
    }
    const q = pickString(args, QUERY_KEYS);
    if (slug === 'web_search') {
      return { label: q ? `Searching the web for “${q}”…` : 'Searching the web…', kind: 'web' };
    }
    if (/^(search|find|recall|entity_|graph_|peer_)/.test(slug)) {
      return {
        label: q ? `Searching your brain for “${q}”…` : 'Searching your brain…',
        kind: 'brain',
      };
    }
    return { label: 'Working on it…', kind: 'tool' };
  }
  if (/^spill_result:/.test(name)) return { label: 'Working on it…', kind: 'tool' };
  return null;
}
