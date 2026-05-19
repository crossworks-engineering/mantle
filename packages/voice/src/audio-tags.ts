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

import type { AudioTag } from './adapters/types';

/**
 * Render a system-prompt paragraph listing the supported tags. The
 * paragraph is appended to the agent's base system_prompt before the
 * chat call. Returns an empty string when the list is empty, so the
 * caller can unconditionally concatenate the result without churning
 * the prompt for tag-less TTS providers.
 */
export function composeAudioTagInstructions(tags: readonly AudioTag[]): string {
  if (tags.length === 0) return '';

  // Group by category so the prompt is readable. The model handles
  // long flat lists fine but grouped lists land more reliably in our
  // testing — and humans editing the prompt later find it easier.
  const byCategory = new Map<string, AudioTag[]>();
  for (const t of tags) {
    const cat = t.category ?? 'other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(t);
  }

  const sections: string[] = [];
  for (const [cat, list] of byCategory) {
    const items = list
      .map((t) => `  ${t.tag} — ${t.description}`)
      .join('\n');
    sections.push(`${cat}:\n${items}`);
  }

  return [
    '',
    '## Voice expression — inline audio tags',
    '',
    'When your reply will be spoken aloud (voice-in or [VOICE] opt-in),',
    'you can sprinkle inline audio tags to add warmth, beats, and',
    'emotion. These tags ONLY work with the currently-configured voice',
    'model; using them sparingly is more effective than using them often.',
    '',
    ...sections,
    '',
    'Rules of thumb:',
    '- One or two tags per voice reply is usually plenty.',
    '- Place the tag right before the line it should affect.',
    '- Tags are written verbatim with square brackets; the system',
    '  renders them as audio cues (e.g. [laughs] becomes a chuckle).',
    '- If the reply ends up text rather than voice, the tags are',
    '  stripped automatically — feel free to use them and not worry.',
    '',
  ].join('\n');
}

/**
 * Strip any audio tag that looks like `[word]` or `[word phrase]` from
 * the supplied text. We use a permissive pattern so a tag we haven't
 * catalogued yet (because a provider added one) still gets stripped
 * when the reply goes out as text.
 *
 * The permissive pattern intentionally does NOT strip:
 *   - Markdown link text `[label](url)` — the `(` after `]` excludes it.
 *   - Citation markers `[1]` or `[2,3]` — digits/commas excluded.
 *   - Code blocks containing brackets — those are preserved because
 *     this function operates on the model's chat content, not on tool
 *     output. If you ever want to call it on tool output, add a code-
 *     fence aware variant.
 *
 * Returns the cleaned text plus a count of tags removed so callers
 * can log or surface the strip if useful.
 */
export function stripAudioTags(text: string): { text: string; stripped: number } {
  if (!text) return { text: '', stripped: 0 };
  // Match `[token]` where token is letters/spaces (so `[laughs softly]`
  // works) and does NOT contain digits, commas, or be followed by `(`
  // (markdown link). The negative lookahead on `(` is the
  // distinguishing trick.
  const pattern = /\[([a-zA-Z][a-zA-Z\s]{0,40})\](?!\()/g;
  let stripped = 0;
  const cleaned = text.replace(pattern, () => {
    stripped++;
    return '';
  });
  // Collapse runs of whitespace introduced by the strip, then trim
  // leading/trailing space without losing inline structure.
  const tidied = cleaned.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  return { text: tidied, stripped };
}
