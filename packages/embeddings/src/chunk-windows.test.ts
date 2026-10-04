import { describe, expect, it } from 'vitest';
import { CHUNK_WINDOW_CHARS, chunkWindows, planChunkWindows } from './chunk-windows';

const sentence = (n: number, len = 100) => `Sentence ${n} ${'x'.repeat(len - 13)}.`;

describe('chunkWindows', () => {
  it('a short chunk is one window, whitespace collapsed', () => {
    expect(chunkWindows('One line.\n\n  Two   lines.')).toEqual(['One line. Two lines.']);
  });

  it('closes a window before the sentence that would pass the size', () => {
    const text = Array.from({ length: 20 }, (_, i) => sentence(i)).join(' ');
    const ws = chunkWindows(text);
    expect(ws.length).toBeGreaterThan(1);
    for (const w of ws) expect(w.length).toBeLessThanOrEqual(CHUNK_WINDOW_CHARS + 300);
    // No sentence is split, and nothing is lost.
    expect(ws.join(' ')).toBe(text);
  });

  it('a short tail joins the window before it', () => {
    const text = [sentence(1, 780), sentence(2, 780), sentence(3, 100)].join(' ');
    const ws = chunkWindows(text);
    expect(ws).toHaveLength(2);
    expect(ws[1]).toContain('Sentence 3');
  });

  it('cuts one overlong sentence hard', () => {
    const ws = chunkWindows('a'.repeat(3000));
    expect(ws.length).toBeGreaterThanOrEqual(3);
    expect(ws.join('')).toBe('a'.repeat(3000));
  });
});

describe('planChunkWindows', () => {
  const vec = [1, 0];
  it('copies the chunk vector for a one-window chunk, embeds the rest, skips unembedded chunks', () => {
    const long = Array.from({ length: 20 }, (_, i) => sentence(i)).join(' ');
    const plan = planChunkWindows([
      { id: 'a', nodeId: 'n', text: 'Short.', embedding: vec },
      { id: 'b', nodeId: 'n', text: long, embedding: vec },
      { id: 'c', nodeId: 'n', text: long, embedding: null },
    ]);
    expect(plan.copies.map((c) => c.chunk.id)).toEqual(['a']);
    expect(new Set(plan.embeds.map((e) => e.chunk.id))).toEqual(new Set(['b']));
    expect(plan.embeds.map((e) => e.j)).toEqual(plan.embeds.map((_, i) => i));
  });
});
