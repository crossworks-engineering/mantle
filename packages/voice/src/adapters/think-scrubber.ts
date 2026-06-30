/**
 * Stateful scrubber for reasoning/thinking blocks in streamed assistant text.
 *
 * Ported from NousResearch Hermes (`agent/think_scrubber.py`) — a community-
 * hardened state machine for the exact failure mode our OpenAI-compat path is
 * exposed to: open models (DeepSeek-R1, Qwen QwQ, many local Ollama/llama.cpp
 * GGUF builds) emit their chain-of-thought INLINE as `<think>…</think>` mixed
 * into the `content` stream, NOT in a separate `reasoning_content` field. A
 * naive per-delta regex strips the opening `<think>` from one delta, then leaks
 * the reasoning prose in the next delta because no downstream state survives the
 * boundary. Left unscrubbed it streams to the user AND lands in the persisted
 * `assistant_messages.text`.
 *
 * Anthropic (native `thinking_delta`) and OpenRouter's typed `reasoning` field
 * already separate reasoning structurally, so they don't need this — but a model
 * that inlines `<think>` over any transport is caught here defensively.
 *
 * Usage (streaming):
 *
 *   const scrubber = new StreamingThinkScrubber();
 *   for (const delta of stream) {
 *     const visible = scrubber.feed(delta);   // '' while inside a block
 *     if (visible) emit(visible);
 *   }
 *   const tail = scrubber.flush();             // at end of stream
 *   if (tail) emit(tail);
 *
 * The scrubber is re-entrant per stream. Construct a fresh one (or call
 * `reset()`) at the top of each turn so a hung block from an interrupted prior
 * stream can't taint the next turn's output.
 *
 * Usage (one-shot, non-streaming):
 *
 *   const clean = scrubThinkBlocks(message.content);
 *
 * Tag variants handled (case-insensitive): `<think>`, `<thinking>`,
 * `<reasoning>`, `<thought>`, `<REASONING_SCRATCHPAD>`.
 *
 * Block-boundary rule for opens: an opening tag only opens a block when it sits
 * at the start of the stream, after a newline (+ optional whitespace), or when
 * only whitespace precedes it on the current line. This keeps prose that
 * *mentions* a tag ("use <think> tags here") from being over-stripped. Closed
 * pairs (`<think>X</think>`) are always suppressed regardless of boundary — a
 * closed pair is an intentional, bounded construct.
 */

const OPEN_TAG_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'REASONING_SCRATCHPAD'] as const;

/** Literal tag strings, materialised once so the hot path is string ops. */
const OPEN_TAGS: readonly string[] = OPEN_TAG_NAMES.map((n) => `<${n}>`);
const CLOSE_TAGS: readonly string[] = OPEN_TAG_NAMES.map((n) => `</${n}>`);
const MAX_TAG_LEN = Math.max(...[...OPEN_TAGS, ...CLOSE_TAGS].map((t) => t.length));

export class StreamingThinkScrubber {
  /** True while inside an opened block, waiting for a close tag (text discarded). */
  private inBlock = false;
  /** Held-back partial-tag tail; resolved on the next feed() or by flush(). */
  private buf = '';
  /** True iff the most recent emission ended with '\n' (start-of-stream counts). */
  private lastEmittedEndedNewline = true;

  /** Reset all state. Call at the top of every new turn. */
  reset(): void {
    this.inBlock = false;
    this.buf = '';
    this.lastEmittedEndedNewline = true;
  }

  /**
   * Feed one delta; return the scrubbed visible portion. May be '' when the
   * whole delta is reasoning content or is held back pending tag resolution.
   */
  feed(text: string): string {
    if (!text) return '';
    let buf = this.buf + text;
    this.buf = '';
    const out: string[] = [];

    while (buf) {
      if (this.inBlock) {
        // Hunt for the earliest close tag.
        const [closeIdx, closeLen] = findFirstTag(buf, CLOSE_TAGS);
        if (closeIdx === -1) {
          // No close yet — hold a potential partial close-tag prefix; discard rest.
          const held = maxPartialSuffix(buf, CLOSE_TAGS);
          this.buf = held ? buf.slice(-held) : '';
          return out.join('');
        }
        // Found close: discard block content + tag, continue.
        buf = buf.slice(closeIdx + closeLen);
        this.inBlock = false;
      } else {
        // Priority 1 — closed <tag>X</tag> pair anywhere in buf (no boundary gate).
        const pair = findEarliestClosedPair(buf);
        // Priority 2 — unterminated open tag at a block boundary (boundary-gated).
        const [openIdx, openLen] = this.findOpenAtBoundary(buf, out);

        // Pick whichever match comes earliest in the buffer.
        if (pair !== null && (openIdx === -1 || pair[0] <= openIdx)) {
          const [startIdx, endIdx] = pair;
          let preceding = buf.slice(0, startIdx);
          if (preceding) {
            preceding = stripOrphanCloseTags(preceding);
            if (preceding) {
              out.push(preceding);
              this.lastEmittedEndedNewline = preceding.endsWith('\n');
            }
          }
          buf = buf.slice(endIdx);
          continue;
        }

        if (openIdx !== -1) {
          // Unterminated open at boundary — emit preceding, enter block, continue.
          let preceding = buf.slice(0, openIdx);
          if (preceding) {
            preceding = stripOrphanCloseTags(preceding);
            if (preceding) {
              out.push(preceding);
              this.lastEmittedEndedNewline = preceding.endsWith('\n');
            }
          }
          this.inBlock = true;
          buf = buf.slice(openIdx + openLen);
          continue;
        }

        // No resolvable tag structure. Hold any partial-tag prefix at the tail
        // (so a tag split across deltas isn't missed), emit the rest.
        const held = Math.max(maxPartialSuffix(buf, OPEN_TAGS), maxPartialSuffix(buf, CLOSE_TAGS));
        let emitText: string;
        if (held) {
          emitText = buf.slice(0, -held);
          this.buf = buf.slice(-held);
        } else {
          emitText = buf;
          this.buf = '';
        }
        if (emitText) {
          emitText = stripOrphanCloseTags(emitText);
          if (emitText) {
            out.push(emitText);
            this.lastEmittedEndedNewline = emitText.endsWith('\n');
          }
        }
        return out.join('');
      }
    }

    return out.join('');
  }

  /**
   * End-of-stream flush. If still inside an unterminated block, held content is
   * discarded (leaking partial reasoning is worse than a truncated answer).
   * Otherwise the held-back partial-tag tail is emitted verbatim — it turned out
   * not to be a real tag prefix.
   */
  flush(): string {
    if (this.inBlock) {
      this.buf = '';
      this.inBlock = false;
      return '';
    }
    let tail = this.buf;
    this.buf = '';
    if (!tail) return '';
    tail = stripOrphanCloseTags(tail);
    if (tail) this.lastEmittedEndedNewline = tail.endsWith('\n');
    return tail;
  }

  // ── internal ────────────────────────────────────────────────────────────

  /** Earliest block-boundary open-tag (idx, len), or (-1, 0). */
  private findOpenAtBoundary(buf: string, alreadyEmitted: string[]): [number, number] {
    const bufLower = buf.toLowerCase();
    let bestIdx = -1;
    let bestLen = 0;
    for (const tag of OPEN_TAGS) {
      const tagLower = tag.toLowerCase();
      let searchStart = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const idx = bufLower.indexOf(tagLower, searchStart);
        if (idx === -1) break;
        if (this.isBlockBoundary(buf, idx, alreadyEmitted)) {
          if (bestIdx === -1 || idx < bestIdx) {
            bestIdx = idx;
            bestLen = tag.length;
          }
          break; // first boundary hit for this tag is enough
        }
        searchStart = idx + 1;
      }
    }
    return [bestIdx, bestLen];
  }

  /** True iff position idx in buf is a block boundary (see class doc). */
  private isBlockBoundary(buf: string, idx: number, alreadyEmitted: string[]): boolean {
    if (idx === 0) {
      if (alreadyEmitted.length) return alreadyEmitted[alreadyEmitted.length - 1]!.endsWith('\n');
      return this.lastEmittedEndedNewline;
    }
    const preceding = buf.slice(0, idx);
    const lastNl = preceding.lastIndexOf('\n');
    if (lastNl === -1) {
      const priorNewline = alreadyEmitted.length
        ? alreadyEmitted[alreadyEmitted.length - 1]!.endsWith('\n')
        : this.lastEmittedEndedNewline;
      return priorNewline && preceding.trim() === '';
    }
    return preceding.slice(lastNl + 1).trim() === '';
  }
}

/** Earliest (index, length) over `tags`, or (-1, 0). Case-insensitive. */
function findFirstTag(buf: string, tags: readonly string[]): [number, number] {
  const bufLower = buf.toLowerCase();
  let bestIdx = -1;
  let bestLen = 0;
  for (const tag of tags) {
    const idx = bufLower.indexOf(tag.toLowerCase());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestLen = tag.length;
    }
  }
  return [bestIdx, bestLen];
}

/**
 * Earliest closed `<tag>…</tag>` pair as [start, end), or null. Non-greedy
 * (closest close after the open wins), matching `<tag>.*?</tag>`. When variants
 * both match, the earliest open wins. Case-insensitive.
 */
function findEarliestClosedPair(buf: string): [number, number] | null {
  const bufLower = buf.toLowerCase();
  let best: [number, number] | null = null;
  for (let i = 0; i < OPEN_TAGS.length; i++) {
    const openLower = OPEN_TAGS[i]!.toLowerCase();
    const closeLower = CLOSE_TAGS[i]!.toLowerCase();
    const openIdx = bufLower.indexOf(openLower);
    if (openIdx === -1) continue;
    const closeIdx = bufLower.indexOf(closeLower, openIdx + openLower.length);
    if (closeIdx === -1) continue;
    const endIdx = closeIdx + closeLower.length;
    if (best === null || openIdx < best[0]) best = [openIdx, endIdx];
  }
  return best;
}

/**
 * Longest buf-suffix that is a (strict) prefix of any tag — the bytes to hold
 * back so a tag split across deltas isn't missed. Case-insensitive.
 */
function maxPartialSuffix(buf: string, tags: readonly string[]): number {
  if (!buf) return 0;
  const bufLower = buf.toLowerCase();
  const maxCheck = Math.min(bufLower.length, MAX_TAG_LEN - 1);
  for (let i = maxCheck; i > 0; i--) {
    const suffix = bufLower.slice(-i);
    for (const tag of tags) {
      const tagLower = tag.toLowerCase();
      if (tagLower.length > i && tagLower.startsWith(suffix)) return i;
    }
  }
  return 0;
}

/**
 * Remove orphan close tags (no matching open in current state) plus trailing
 * whitespace, so the surrounding prose flows naturally.
 */
function stripOrphanCloseTags(text: string): string {
  if (!text.includes('</')) return text;
  const textLower = text.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    if (textLower.slice(i, i + 2) === '</') {
      for (const tag of CLOSE_TAGS) {
        const tagLower = tag.toLowerCase();
        const tagLen = tagLower.length;
        if (textLower.slice(i, i + tagLen) === tagLower) {
          let j = i + tagLen;
          while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) {
            j++;
          }
          i = j;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      out.push(text[i]!);
      i++;
    }
  }
  return out.join('');
}

/**
 * One-shot scrub of a complete (non-streamed) assistant message: strip any
 * reasoning blocks and return only the visible text. Equivalent to feeding the
 * whole string then flushing.
 */
export function scrubThinkBlocks(text: string): string {
  if (!text || (!text.includes('<') && !text.includes('</'))) return text;
  const s = new StreamingThinkScrubber();
  return s.feed(text) + s.flush();
}
