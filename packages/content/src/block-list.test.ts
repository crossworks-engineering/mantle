/**
 * Unit tests for listBlocks — the TOC extraction that powers
 * `page_blocks_list` (the agent's "what's in this page?" lookup).
 */

import { describe, expect, it } from 'vitest';
import { ensureBlockIds } from './block-ids';
import { listBlocks } from './block-list';

function blocked(doc: Record<string, unknown>): Record<string, unknown> {
  // Always run through ensureBlockIds so the listings have stable ids,
  // matching the real call path (markdownToDoc / getPage / saveDraft).
  return ensureBlockIds(doc);
}

describe('listBlocks', () => {
  it('lists top-level blocks in document order with depth=1', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hi' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
        { type: 'horizontalRule' },
      ],
    });
    const blocks = listBlocks(doc);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'horizontalRule']);
    expect(blocks.every((b) => b.depth === 1)).toBe(true);
    expect(blocks.every((b) => typeof b.id === 'string' && b.id.length > 8)).toBe(true);
  });

  it('captures previews from text content, single-line + trimmed', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '  Hello   ' },
            { type: 'text', text: '  world\n', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    });
    const [p] = listBlocks(doc);
    expect(p?.preview).toBe('Hello world');
  });

  it('truncates previews with an ellipsis past the cap', () => {
    const long = 'x'.repeat(200);
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: long }] }],
    });
    const [p] = listBlocks(doc, { previewChars: 50 });
    expect(p?.preview.length).toBeLessThanOrEqual(50);
    expect(p?.preview.endsWith('…')).toBe(true);
  });

  it('includes meta — heading level, code language, callout variant', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
        {
          type: 'callout',
          attrs: { variant: 'warning' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'careful' }] }],
        },
      ],
    });
    const blocks = listBlocks(doc);
    expect(blocks[0]!.meta).toEqual({ level: 2 });
    expect(blocks[1]!.meta).toEqual({ language: 'typescript' });
    expect(blocks[2]!.meta).toEqual({ variant: 'warning' });
  });

  it('walks into containers — callout body shows at depth=2', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'inside' }] },
          ],
        },
      ],
    });
    const blocks = listBlocks(doc);
    expect(blocks).toHaveLength(2); // callout + inner paragraph
    expect(blocks[0]).toMatchObject({ kind: 'callout', depth: 1 });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', depth: 2, preview: 'inside' });
  });

  it('respects maxDepth — only top-level when maxDepth=1', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'inside' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'too' }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    });
    const blocks = listBlocks(doc, { maxDepth: 1 });
    expect(blocks).toHaveLength(2); // callout + 'after' paragraph, no inner
    expect(blocks.map((b) => b.kind)).toEqual(['callout', 'paragraph']);
  });

  it('columnList → columns → inner blocks all listed in document order', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'columnList',
          content: [
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'L' }] }],
            },
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'R' }] }],
            },
          ],
        },
      ],
    });
    const blocks = listBlocks(doc);
    expect(blocks.map((b) => `${b.kind}@${b.depth}:${b.preview || '-'}`)).toEqual([
      'columnList@1:L R',
      'column@2:L',
      'paragraph@3:L',
      'column@2:R',
      'paragraph@3:R',
    ]);
  });

  it('stays compact — 50–80 bytes per typical block in JSON', () => {
    const doc = blocked({
      type: 'doc',
      content: Array.from({ length: 50 }, (_, i) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: `Block ${i} with some moderately long content here.` }],
      })),
    });
    const blocks = listBlocks(doc);
    const serialized = JSON.stringify(blocks);
    const bytesPerBlock = serialized.length / blocks.length;
    expect(blocks).toHaveLength(50);
    // Each entry: id (36) + kind (~9) + depth (1) + preview (~60) + JSON
    // overhead. Generous upper bound — if we ever blow past this something
    // changed in the shape and the agent's tool-result budget is at risk.
    expect(bytesPerBlock).toBeLessThan(180);
  });
});
