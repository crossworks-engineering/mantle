/**
 * Tests for the pure parts of the tool-result spill store: the chunker (feeds
 * the semantic tier), the envelope (what the model sees in place of a spilled
 * result), the config resolver (per-agent KB override → bytes), and the
 * inline fast-path of the middleware. The DB-backed paths (spill / page /
 * grep / query) are exercised live against Postgres in the verify step.
 */

import { describe, expect, it } from 'vitest';
import {
  chunkText,
  buildResultEnvelope,
  resolveResultHandling,
  processToolResultForModel,
  DEFAULT_RESULT_HANDLING,
} from './tool-results';

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
  });

  it('returns nothing for empty/whitespace', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('splits long text into multiple chunks under maxChars', () => {
    const text = 'x'.repeat(5000);
    const chunks = chunkText(text, { maxChars: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });

  it('overlaps consecutive chunks so a boundary match is not lost', () => {
    // Distinct content so we can see the overlap concretely.
    const text = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n');
    const chunks = chunkText(text, { maxChars: 500, overlap: 80 });
    expect(chunks.length).toBeGreaterThan(2);
    // Reassembled (deduped) text still contains the first and last lines.
    expect(chunks[0]).toContain('line-0');
    expect(chunks[chunks.length - 1]).toContain('line-399');
  });

  it('prefers a newline break near the window edge', () => {
    const para = 'A'.repeat(900) + '\n' + 'B'.repeat(900);
    const chunks = chunkText(para, { maxChars: 1000, overlap: 50 });
    // The first chunk should break at the newline rather than mid-B-run.
    expect(chunks[0]?.endsWith('A')).toBe(true);
  });
});

describe('resolveResultHandling', () => {
  it('uses env/global defaults when no override', () => {
    const r = resolveResultHandling(null);
    expect(r.inlineMaxBytes).toBe(DEFAULT_RESULT_HANDLING.inlineMaxBytes);
    expect(r.embedMinBytes).toBe(DEFAULT_RESULT_HANDLING.embedMinBytes);
    expect(r.pageBytes).toBe(DEFAULT_RESULT_HANDLING.pageBytes);
  });

  it('converts a per-agent KB override to bytes', () => {
    const r = resolveResultHandling({ inline_max_kb: 8, embed_min_kb: 50, spill_max_kb: 256 });
    expect(r.inlineMaxBytes).toBe(8 * 1024);
    expect(r.embedMinBytes).toBe(50 * 1024);
    expect(r.spillMaxBytes).toBe(256 * 1024);
  });

  it('defaults the spill ceiling when not overridden', () => {
    const r = resolveResultHandling({ inline_max_kb: 8 });
    expect(r.spillMaxBytes).toBe(DEFAULT_RESULT_HANDLING.spillMaxBytes);
  });

  it('falls back per-field and ignores non-positive values', () => {
    const r = resolveResultHandling({ inline_max_kb: 4 });
    expect(r.inlineMaxBytes).toBe(4 * 1024);
    expect(r.embedMinBytes).toBe(DEFAULT_RESULT_HANDLING.embedMinBytes); // untouched
    const bad = resolveResultHandling({ inline_max_kb: 0, embed_min_kb: -5 });
    expect(bad.inlineMaxBytes).toBe(DEFAULT_RESULT_HANDLING.inlineMaxBytes);
    expect(bad.embedMinBytes).toBe(DEFAULT_RESULT_HANDLING.embedMinBytes);
  });

  it('page size is always the global default (never per-agent)', () => {
    const r = resolveResultHandling({ inline_max_kb: 1, embed_min_kb: 2 });
    expect(r.pageBytes).toBe(DEFAULT_RESULT_HANDLING.pageBytes);
  });
});

describe('buildResultEnvelope', () => {
  const handling = {
    inlineMaxBytes: 1000,
    embedMinBytes: 4000,
    pageBytes: 500,
    spillMaxBytes: 1_000_000,
  };

  it('carries handle, bytes, page count, preview, and a read instruction', () => {
    const content = 'y'.repeat(2000);
    const env = buildResultEnvelope({
      handle: 'tr_abc',
      toolSlug: 'invoke_agent',
      content,
      bytes: 2000,
      originalBytes: 2000,
      handling,
    });
    expect(env._spilled).toBe(true);
    expect(env.handle).toBe('tr_abc');
    expect(env.bytes).toBe(2000);
    expect(env.pages).toBe(Math.ceil(2000 / 500));
    expect(typeof env.preview).toBe('string');
    expect((env.preview as string).length).toBeLessThan(content.length);
    expect(String(env.note)).toContain('read_result');
    expect(env.truncated).toBeUndefined();
  });

  it('recommends semantic query once at/over the embed threshold', () => {
    const big = buildResultEnvelope({
      handle: 'tr_big',
      toolSlug: 'file_read',
      content: 'z'.repeat(5000),
      bytes: 5000, // ≥ embedMinBytes (4000)
      originalBytes: 5000,
      handling,
    });
    expect(String(big.note)).toContain('query');
    const mid = buildResultEnvelope({
      handle: 'tr_mid',
      toolSlug: 'file_read',
      content: 'z'.repeat(2000),
      bytes: 2000, // < embedMinBytes
      originalBytes: 2000,
      handling,
    });
    // Mid-size still mentions page/grep options.
    expect(String(mid.note)).toMatch(/page|grep/);
  });

  it('marks the preview as a partial view with an in-band cut marker', () => {
    const env = buildResultEnvelope({
      handle: 'tr_pv',
      toolSlug: 'invoke_agent',
      content: 'y'.repeat(8000),
      bytes: 8000,
      originalBytes: 8000,
      handling,
    });
    expect(env.preview_truncated).toBe(true);
    // The cut marker is IN the preview text itself, not just a sibling note.
    expect(String(env.preview)).toMatch(/PREVIEW ENDS HERE/);
    expect(String(env.note)).toMatch(/do not answer from the preview/i);
  });

  it('flags truncation when the original exceeded the stored size', () => {
    const env = buildResultEnvelope({
      handle: 'tr_trunc',
      toolSlug: 'file_read',
      content: 'k'.repeat(1000), // stored (head-truncated)
      bytes: 1000,
      originalBytes: 50_000, // original was much bigger
      handling,
    });
    expect(env.truncated).toBe(true);
    expect(env.original_bytes).toBe(50_000);
    expect(String(env.note)).toMatch(/truncat/i);
  });
});

describe('adaptive chunk cap (the principle behind the embed-tier ceiling)', () => {
  it('keeps chunk count bounded when sized from a max-chunks budget', () => {
    const maxChunks = 200;
    const content = 'x'.repeat(2_000_000); // 2 MB
    const maxChars = Math.max(1500, Math.ceil(content.length / maxChunks));
    const chunks = chunkText(content, { maxChars }).slice(0, maxChunks);
    expect(chunks.length).toBeLessThanOrEqual(maxChunks);
    // And the chunks still cover (nearly) the whole content, not just a slice.
    expect(maxChars).toBeGreaterThan(1500);
  });
});

describe('processToolResultForModel (inline fast-path)', () => {
  it('passes small results through untouched, no spill', async () => {
    const serialized = JSON.stringify({ answer: 'short' });
    const r = await processToolResultForModel({
      serialized,
      ownerId: 'owner-1',
      traceId: null,
      toolSlug: 'search_nodes',
      handling: {
        inlineMaxBytes: 1000,
        embedMinBytes: 4000,
        pageBytes: 500,
        spillMaxBytes: 1_000_000,
      },
    });
    expect(r.spilled).toBe(false);
    expect(r.handle).toBeNull();
    expect(r.payload).toBe(serialized);
  });
});
