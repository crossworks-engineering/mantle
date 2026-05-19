/**
 * Tests for the audio-tag composition + stripping helpers.
 *
 * Why these exist:
 *   1. `composeAudioTagInstructions` is what makes Saskia use the
 *      right tags — if the paragraph it produces is malformed, the
 *      LLM either ignores it or hallucinates fake tags. Locking down
 *      the output shape catches future regressions.
 *
 *   2. `stripAudioTags` is the safety net that keeps bracketed tags
 *      out of text-mode replies. It must:
 *        - Remove `[laughs]` / `[whispers]` / `[strong british accent]`
 *        - NEVER touch markdown links `[label](url)` (these are not
 *          audio tags; stripping them would break formatted replies)
 *        - NEVER touch citation markers `[1]`, `[2,3]` (digits/commas
 *          excluded by the pattern)
 *        - Clean up whitespace so the strip doesn't leave double
 *          spaces or stranded line breaks
 */

import { describe, expect, it } from 'vitest';
import { composeAudioTagInstructions, stripAudioTags } from './audio-tags';
import { ELEVENLABS_V3_AUDIO_TAGS } from './catalogs/elevenlabs';

describe('composeAudioTagInstructions', () => {
  it('returns empty string for an empty tag list', () => {
    // No-op when the active TTS has no tags — caller concatenates
    // unconditionally, so this MUST be exactly '' (not whitespace).
    expect(composeAudioTagInstructions([])).toBe('');
  });

  it('includes every tag passed in', () => {
    const out = composeAudioTagInstructions(ELEVENLABS_V3_AUDIO_TAGS);
    for (const t of ELEVENLABS_V3_AUDIO_TAGS) {
      expect(out).toContain(t.tag);
      expect(out).toContain(t.description);
    }
  });

  it('groups by category — emotion / reaction / delivery etc.', () => {
    // The prompt's readability comes from grouping. Lock in that
    // each category we use shows up as a section header.
    const out = composeAudioTagInstructions(ELEVENLABS_V3_AUDIO_TAGS);
    expect(out).toContain('reaction:');
    expect(out).toContain('emotion:');
    expect(out).toContain('delivery:');
    expect(out).toContain('cognitive:');
    expect(out).toContain('tone:');
  });

  it('includes the "use sparingly" guidance', () => {
    // Saskia tends to over-use new affordances. The prompt explicitly
    // tells her one or two tags per voice reply is plenty. Without
    // this guidance she peppers every line.
    const out = composeAudioTagInstructions(ELEVENLABS_V3_AUDIO_TAGS);
    expect(out).toMatch(/sparingly|one or two/i);
  });

  it('mentions the auto-strip behaviour for text replies', () => {
    // Tells the LLM it's safe to use tags even if she ends up routed
    // text-out. Otherwise she'd hedge and skip them.
    const out = composeAudioTagInstructions(ELEVENLABS_V3_AUDIO_TAGS);
    expect(out).toMatch(/strip|text/i);
  });
});

describe('stripAudioTags', () => {
  it('strips a single-word tag', () => {
    const { text, stripped } = stripAudioTags('Hey [laughs] that was funny.');
    expect(text).toBe('Hey that was funny.');
    expect(stripped).toBe(1);
  });

  it('strips multi-word tags', () => {
    // ElevenLabs has tags like [strong British accent] and
    // [resigned tone] — multi-word; the pattern allows spaces.
    const { text } = stripAudioTags('[resigned tone] Fine.');
    expect(text).toBe('Fine.');
  });

  it('strips multiple tags in one string', () => {
    const { text, stripped } = stripAudioTags(
      '[whispers] keep it quiet — [laughs] not THAT quiet.',
    );
    expect(text).toBe('keep it quiet — not THAT quiet.');
    expect(stripped).toBe(2);
  });

  it('preserves markdown links — [label](url) is NOT a tag', () => {
    // The negative lookahead on `(` is the critical mechanism. If
    // this breaks, replies with markdown links lose their visible
    // text.
    const { text, stripped } = stripAudioTags(
      'See the [docs](https://example.com) for details.',
    );
    expect(text).toBe('See the [docs](https://example.com) for details.');
    expect(stripped).toBe(0);
  });

  it('preserves citation markers — [1] [2,3] are NOT tags', () => {
    // Citation markers contain digits/commas; our pattern requires
    // letters only. Lock down the behaviour.
    const { text, stripped } = stripAudioTags(
      'Per [1] and [2,3], the result holds.',
    );
    expect(text).toBe('Per [1] and [2,3], the result holds.');
    expect(stripped).toBe(0);
  });

  it('handles an empty / null input gracefully', () => {
    expect(stripAudioTags('').text).toBe('');
    expect(stripAudioTags('').stripped).toBe(0);
  });

  it('counts tags removed in the return value', () => {
    // The agent runtime puts this on the trace step meta so we can
    // tell, post-hoc, whether the LLM was using tags this turn.
    const { stripped } = stripAudioTags('[laughs] [sighs] [whispers] hi');
    expect(stripped).toBe(3);
  });

  it('does not introduce double spaces after stripping', () => {
    const { text } = stripAudioTags('Hey [laughs] there.');
    // Should be one space between 'Hey' and 'there.', not two.
    expect(text).not.toMatch(/ {2}/);
  });

  it('handles tags at the start of a line cleanly', () => {
    const { text } = stripAudioTags('[whispers] secret message.');
    expect(text).toBe('secret message.');
  });

  it('does not match unbracketed text that looks tag-shaped', () => {
    // `laughs` without brackets is just a word.
    const { text } = stripAudioTags('She laughs a lot.');
    expect(text).toBe('She laughs a lot.');
  });

  it('caps the matchable token length (defensive)', () => {
    // A very long bracketed string (e.g. 200 chars) shouldn't be
    // treated as a tag — the pattern caps token length at 40 chars
    // to avoid eating long-bracketed editorial inserts. Test this
    // by passing a long bracketed phrase.
    const long = '[' + 'word '.repeat(20).trim() + ']'; // ~100 chars
    const { text } = stripAudioTags(`prefix ${long} suffix`);
    // The long bracketed string should be preserved (NOT stripped).
    expect(text).toContain(long);
  });
});
