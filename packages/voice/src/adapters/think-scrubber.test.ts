import { describe, it, expect } from 'vitest';
import { StreamingThinkScrubber, scrubThinkBlocks } from './think-scrubber';

/** Feed an array of deltas and return the concatenated visible output + flush. */
function run(deltas: string[]): string {
  const s = new StreamingThinkScrubber();
  let out = '';
  for (const d of deltas) out += s.feed(d);
  out += s.flush();
  return out;
}

describe('StreamingThinkScrubber', () => {
  it('strips a closed pair arriving in one delta', () => {
    expect(run(['<think>secret</think>visible'])).toBe('visible');
  });

  it('strips a block split across deltas (the per-delta-regex bug)', () => {
    // The exact failure mode: open, body, close each in their own delta.
    expect(run(['<think>', 'let me check the config', '</think>', 'Answer.'])).toBe('Answer.');
  });

  it('holds a partial open tag across the delta boundary', () => {
    // '<thi' must be held, not emitted, until the next delta resolves it.
    expect(run(['hello <thi', 'nk>secret</think> world'])).toBe('hello  world');
  });

  it('holds a partial close tag across the boundary', () => {
    expect(run(['<think>reasoning</thi', 'nk>done'])).toBe('done');
  });

  it('keeps prose that merely mentions a tag mid-line (boundary gate)', () => {
    // Not at a block boundary → not treated as an opener.
    expect(run(['use the <think> tag here'])).toBe('use the <think> tag here');
  });

  it('treats an open tag after a newline as a real block', () => {
    expect(run(['intro\n<think>hidden</think>\nout'])).toBe('intro\n\nout');
  });

  it('discards an unterminated block on flush (no leak)', () => {
    // Open tag at a block boundary (start of stream) with no close → discarded.
    expect(run(['<think>thinking that never closes...'])).toBe('');
    // And after a newline boundary, preceding prose survives, block is dropped.
    expect(run(['answer\n<think>thinking that never closes...'])).toBe('answer\n');
  });

  it('leaves a mid-line tag mention as prose (boundary gate, not an opener)', () => {
    // Local reasoning models emit <think> at the START of content, so a tag that
    // appears mid-line after real prose is treated as literal text, not a block.
    expect(run(['answer <think>not really a block'])).toBe('answer <think>not really a block');
  });

  it('strips orphan close tags', () => {
    expect(run(['hello </think> world'])).toBe('hello world');
  });

  it('passes plain text through untouched', () => {
    expect(run(['just a normal reply, no tags'])).toBe('just a normal reply, no tags');
  });

  it('handles tag variants case-insensitively', () => {
    expect(run(['<REASONING_SCRATCHPAD>x</REASONING_SCRATCHPAD>A'])).toBe('A');
    expect(run(['<Thinking>y</Thinking>B'])).toBe('B');
  });

  it('emits text before and after a block', () => {
    expect(run(['before <think>mid</think> after'])).toBe('before  after');
  });

  it('handles multiple blocks in a stream', () => {
    expect(run(['<think>a</think>X', '<think>b</think>Y'])).toBe('XY');
  });

  it('reset() clears a hung block so the next turn is clean', () => {
    const s = new StreamingThinkScrubber();
    s.feed('<think>unterminated');
    s.reset();
    expect(s.feed('fresh answer') + s.flush()).toBe('fresh answer');
  });
});

describe('scrubThinkBlocks (one-shot)', () => {
  it('strips a complete inline block', () => {
    expect(scrubThinkBlocks('<think>reasoning</think>The answer is 42.')).toBe('The answer is 42.');
  });

  it('drops an unterminated trailing block', () => {
    expect(scrubThinkBlocks('Answer.\n<think>leftover open')).toBe('Answer.\n');
  });

  it('is a no-op for tag-free text (fast path)', () => {
    expect(scrubThinkBlocks('nothing to strip')).toBe('nothing to strip');
  });

  it('returns empty string unchanged', () => {
    expect(scrubThinkBlocks('')).toBe('');
  });
});
