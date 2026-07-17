/**
 * Helpers for audio-tag composition and sanitisation.
 *
 * Two jobs:
 *   1. Build the system-prompt paragraph that tells the chat agent
 *      which tags the active TTS will honour. Saskia uses this to
 *      emit `[laughs]` / `[whispers]` / `[sighs]` etc. in voice
 *      replies — but only when the configured TTS actually renders
 *      them (ElevenLabs v3 does; OpenAI tts-1 doesn't; the tag
 *      adapter is the source of truth).
 *
 *   2. Strip audio tags from text-mode replies before they go out
 *      on the chat surface. The LLM doesn't always know in advance
 *      whether the reply will go as text or voice (`[VOICE]` opt-in
 *      is decided AFTER the LLM finishes), so we let her use tags
 *      freely and pull them out if she ends up routed to sendMessage.
 *
 * Both helpers are pure (no I/O, no DB, no provider calls), so they
 * test cleanly and can be called from either runtime or the web's
 * server-action layer.
 */

import type { AudioTag, WrappingTag } from './adapters/types';

/** Group a tag list by its `category`, preserving first-seen order. */
function groupByCategory<T extends { category?: string }>(tags: readonly T[]): Map<string, T[]> {
  const byCategory = new Map<string, T[]>();
  for (const t of tags) {
    const cat = t.category ?? 'other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(t);
  }
  return byCategory;
}

/**
 * Render a system-prompt paragraph listing the supported voice tags.
 * The paragraph is appended to the agent's base system_prompt before
 * the chat call. Returns an empty string when both lists are empty, so
 * the caller can unconditionally concatenate the result without
 * churning the prompt for tag-less TTS providers.
 *
 * Two vocabularies, one paragraph:
 *   - `inline` — point-in-time `[bracket]` cues (`[laughs]`, `[pause]`).
 *   - `wrapping` — angle-bracket pairs that style a span
 *     (`<whisper>…</whisper>`, `<soft>…</soft>`). xAI Grok voice today.
 *
 * `wrapping` defaults to `[]` so existing callers that only pass inline
 * tags keep their exact output.
 */
export function composeAudioTagInstructions(
  inline: readonly AudioTag[],
  wrapping: readonly WrappingTag[] = [],
): string {
  if (inline.length === 0 && wrapping.length === 0) return '';

  // Group by category so the prompt is readable. The model handles
  // long flat lists fine but grouped lists land more reliably in our
  // testing — and humans editing the prompt later find it easier.
  const inlineSections: string[] = [];
  for (const [cat, list] of groupByCategory(inline)) {
    const items = list.map((t) => `  ${t.tag} — ${t.description}`).join('\n');
    inlineSections.push(`${cat}:\n${items}`);
  }

  const wrappingSections: string[] = [];
  for (const [cat, list] of groupByCategory(wrapping)) {
    const items = list.map((t) => `  <${t.name}>…</${t.name}> — ${t.description}`).join('\n');
    wrappingSections.push(`${cat}:\n${items}`);
  }

  const lines: string[] = [
    '',
    '## Voice expression — speech tags',
    '',
    'When your reply will be spoken aloud (voice-in or [VOICE] opt-in),',
    'you can use speech tags to add warmth, beats, and emotion. These',
    'tags ONLY work with the currently-configured voice model; using',
    'them sparingly is more effective than using them often.',
    '',
  ];

  if (inlineSections.length > 0) {
    lines.push(
      'Inline tags — written verbatim with square brackets, they fire at',
      'the point they sit (e.g. [laughs] becomes a chuckle right there):',
      '',
      ...inlineSections,
      '',
    );
  }

  if (wrappingSections.length > 0) {
    lines.push(
      'Wrapping tags — angle-bracket pairs that style the whole phrase',
      'they surround (e.g. <whisper>keep this quiet</whisper>). Always',
      'close the tag you open:',
      '',
      ...wrappingSections,
      '',
    );
  }

  lines.push(
    'Rules of thumb:',
    '- One or two tags per voice reply is usually plenty.',
    '- Place an inline tag right before the line it should affect;',
    '  wrap only the exact words a wrapping tag should style.',
    '- If the reply ends up text rather than voice, the tags are',
    '  stripped automatically — feel free to use them and not worry.',
    '',
  );

  return lines.join('\n');
}

/**
 * The wrapping-tag names the stripper recognises. This is a curated
 * superset of every provider's wrapping vocabulary (xAI Grok today)
 * plus a few defensive synonyms — used ONLY by {@link stripAudioTags}
 * as the safety net for text-out replies. We match by explicit name
 * rather than "any `<word>`" so we never touch autolinks
 * (`<https://…>`), email brackets, or real HTML/markdown the model may
 * legitimately emit. Keep it conservative: only add names that are
 * unambiguously speech-delivery styles.
 */
const WRAPPING_TAG_NAMES = [
  'whisper',
  'soft',
  'loud',
  'quiet',
  'slow',
  'fast',
  'high',
  'low',
  'emphasis',
  'singing',
  'sing-song',
  'shout',
] as const;

/**
 * Strip voice tags from a reply that's going out as plain text. Two
 * vocabularies are removed:
 *
 *   - Inline `[word]` / `[word phrase]` cues (`[laughs]`, `[pause]`).
 *     Permissive pattern so a not-yet-catalogued bracket tag still gets
 *     stripped. Intentionally does NOT strip:
 *       · Markdown link text `[label](url)` — the `(` after `]` excludes it.
 *       · Citation markers `[1]` / `[2,3]` — digits/commas excluded.
 *       · Code blocks with brackets — this runs on chat content, not
 *         tool output. Add a fence-aware variant if that changes.
 *
 *   - Wrapping `<name>…</name>` markers (`<whisper>`, `<soft>`, …). The
 *     INNER TEXT is kept; only the angle-bracket markers are removed,
 *     so `<whisper>it's a secret</whisper>` → `it's a secret`. Matched
 *     against {@link WRAPPING_TAG_NAMES} so generic angle-bracket
 *     content (autolinks, HTML) is left alone.
 *
 * Returns the cleaned text plus a count of markers removed (inline tags
 * + wrapping markers) so callers can log or surface the strip.
 */
export function stripAudioTags(text: string): { text: string; stripped: number } {
  if (!text) return { text: '', stripped: 0 };
  let stripped = 0;

  // Inline `[token]` — letters/spaces only (so `[laughs softly]` works),
  // no digits/commas, not followed by `(` (markdown link). The negative
  // lookahead on `(` is the distinguishing trick.
  const inlinePattern = /\[([a-zA-Z][a-zA-Z\s]{0,40})\](?!\()/g;
  let cleaned = text.replace(inlinePattern, () => {
    stripped++;
    return '';
  });

  // Wrapping `<name>` / `</name>` for the known speech-style names.
  // Case-insensitive; removes the markers, keeps the inner text.
  const wrappingPattern = new RegExp(`</?(?:${WRAPPING_TAG_NAMES.join('|')})\\s*>`, 'gi');
  cleaned = cleaned.replace(wrappingPattern, () => {
    stripped++;
    return '';
  });

  // Collapse runs of whitespace introduced by the strip, then trim
  // leading/trailing space without losing inline structure.
  const tidied = cleaned
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
  return { text: tidied, stripped };
}
