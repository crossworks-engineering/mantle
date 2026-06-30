/**
 * Accumulator for streamed `reasoning_details` blocks (OpenRouter).
 *
 * When a reasoning model streams, OpenRouter emits `reasoning_details` as
 * FRAGMENTS keyed by `index`: a block's `text` arrives in pieces and its
 * `signature` lands once (usually on the closing fragment). To replay a
 * thinking-then-tool_use turn on the next request — which Anthropic (via
 * OpenRouter) REQUIRES, or it 400s — we must reassemble each block exactly,
 * because the signature is validated against the full thinking text. Getting
 * this wrong corrupts the signature and the replay is rejected; hence this is
 * isolated and unit-tested rather than inlined in the stream loop.
 *
 * Merge rules per index:
 *   - `text` / `data` / `summary`: concatenate fragments in arrival order.
 *   - `signature`: last non-null wins (it's emitted whole, once).
 *   - `type` / `format` / `id`: set from the first fragment that carries them.
 */

import type { ReasoningDetail } from './types';

type Fragment = {
  type?: string;
  index?: number;
  text?: string | null;
  data?: string | null;
  summary?: string | null;
  signature?: string | null;
  format?: string | null;
  id?: string | null;
};

export class ReasoningDetailsAccumulator {
  private readonly byIndex = new Map<number, ReasoningDetail>();
  /** Insertion order of indices, so the assembled array preserves block order
   *  even when `index` values aren't contiguous from zero. */
  private readonly order: number[] = [];

  /** Fold one streamed `reasoning_details` array (a delta) into the state. */
  add(frags: Fragment[] | undefined | null): void {
    if (!Array.isArray(frags)) return;
    for (const f of frags) {
      if (!f || typeof f !== 'object') continue;
      const idx = typeof f.index === 'number' ? f.index : 0;
      let cur = this.byIndex.get(idx);
      if (!cur) {
        cur = { type: typeof f.type === 'string' ? f.type : 'reasoning.text' };
        this.byIndex.set(idx, cur);
        this.order.push(idx);
      }
      if (typeof f.type === 'string' && f.type) cur.type = f.type;
      // Carry the block's own index back (only when the provider actually sent
      // one — don't fabricate index:0 for index-less single blocks).
      if (typeof f.index === 'number') cur.index = f.index;
      if (typeof f.text === 'string') cur.text = (cur.text ?? '') + f.text;
      if (typeof f.data === 'string') cur.data = (cur.data ?? '') + f.data;
      if (typeof f.summary === 'string') cur.summary = (cur.summary ?? '') + f.summary;
      // signature / format / id are emitted whole — last non-empty wins.
      if (typeof f.signature === 'string' && f.signature) cur.signature = f.signature;
      if (typeof f.format === 'string' && f.format) cur.format = f.format;
      if (typeof f.id === 'string' && f.id) cur.id = f.id;
    }
  }

  /** Whether any reasoning block was seen. */
  get isEmpty(): boolean {
    return this.order.length === 0;
  }

  /** The assembled blocks in arrival order, or undefined if none. */
  result(): ReasoningDetail[] | undefined {
    if (this.order.length === 0) return undefined;
    return this.order.map((i) => this.byIndex.get(i)!);
  }
}

/** One-shot helper: normalise a complete `reasoning_details` array (from a
 *  non-streamed response message) into our `ReasoningDetail[]`, or undefined. */
export function normalizeReasoningDetails(raw: unknown): ReasoningDetail[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ReasoningDetail[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const f = r as Fragment;
    out.push({
      type: typeof f.type === 'string' ? f.type : 'reasoning.text',
      ...(typeof f.index === 'number' ? { index: f.index } : {}),
      ...(typeof f.text === 'string' ? { text: f.text } : {}),
      ...(typeof f.data === 'string' ? { data: f.data } : {}),
      ...(typeof f.summary === 'string' ? { summary: f.summary } : {}),
      ...(typeof f.signature === 'string' ? { signature: f.signature } : {}),
      ...(typeof f.format === 'string' ? { format: f.format } : {}),
      ...(typeof f.id === 'string' ? { id: f.id } : {}),
    });
  }
  return out.length ? out : undefined;
}
