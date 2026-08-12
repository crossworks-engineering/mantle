/**
 * Tests for declarative tool preconditions. The three teaching errors under
 * test are the referential-mistake ladder: malformed id (a title where an
 * id belongs), missing node, and — the one handlers never report well —
 * an id that exists but names the WRONG TYPE of node.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db', () => ({ db: {}, nodes: {} }));

import { checkToolPreconditions } from './preconditions';
import type { ToolPrecondition } from './types';

const PAGE_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'page_id', nodeType: 'page', lookup: 'page_list / search_nodes' },
];

const PAGE_ID = '1a2b3c4d-0000-4000-8000-000000000001';

describe('checkToolPreconditions', () => {
  it('passes when the node exists with the right type', async () => {
    const res = await checkToolPreconditions(
      PAGE_PRE,
      { page_id: PAGE_ID },
      'o1',
      async () => 'page',
    );
    expect(res).toBeNull();
  });

  it('teaches when the id is not a UUID (title passed instead of id)', async () => {
    const res = await checkToolPreconditions(
      PAGE_PRE,
      { page_id: 'Weekly Ops Overview' },
      'o1',
      async () => null,
    );
    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.error).toContain("'page_id' must be a page id (UUID)");
      expect(res.error).toContain('Weekly Ops Overview');
      expect(res.error).toContain('pass the id, not a title');
      expect(res.error).toContain('page_list / search_nodes');
    }
  });

  it('returns the standard notFound teaching error for a missing node', async () => {
    const res = await checkToolPreconditions(
      PAGE_PRE,
      { page_id: PAGE_ID },
      'o1',
      async () => null,
    );
    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.error).toContain(`page ${PAGE_ID} not found`);
      expect(res.error).toContain('page_list / search_nodes');
    }
  });

  it('teaches the wrong-type case explicitly', async () => {
    const res = await checkToolPreconditions(
      PAGE_PRE,
      { page_id: PAGE_ID },
      'o1',
      async () => 'note',
    );
    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.error).toContain('is a note, not a page');
      expect(res.error).toContain('pass a page id');
    }
  });

  it('skips absent/empty params (presence is the schema validator’s job)', async () => {
    const lookup = vi.fn(async () => 'page');
    expect(await checkToolPreconditions(PAGE_PRE, {}, 'o1', lookup)).toBeNull();
    expect(await checkToolPreconditions(PAGE_PRE, { page_id: '' }, 'o1', lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts any node type when nodeType is unset', async () => {
    const anyNode: readonly ToolPrecondition[] = [
      { kind: 'node_exists', param: 'id', lookup: 'search_nodes' },
    ];
    const res = await checkToolPreconditions(anyNode, { id: PAGE_ID }, 'o1', async () => 'journal');
    expect(res).toBeNull();
  });
});

/**
 * markdown_refs: the ids that ride inside a body. The regression these pin is
 * a real one — a page was stored with `media:2153d1f2-8b39-…`, a UUID the model
 * built out of the 8-char prefix the corpus map displays, and the write
 * succeeded, so the page rendered a blank where the picture belonged.
 */
const FILE_ID = '2153d1f2-c8ed-4bcf-bb76-b99b10f5c077';
const FABRICATED_ID = '2153d1f2-8b39-4f0a-9c65-6c8b6e7f4e5f';

const MD_PRE: readonly ToolPrecondition[] = [{ kind: 'markdown_refs', param: 'markdown' }];

describe('checkToolPreconditions — markdown_refs', () => {
  it('passes a body whose media ref names a real file', async () => {
    const res = await checkToolPreconditions(
      MD_PRE,
      { markdown: `![house](media:${FILE_ID})` },
      'o1',
      async () => 'file',
    );
    expect(res).toBeNull();
  });

  it('refuses a fabricated media id and says not to rebuild ids from prefixes', async () => {
    const res = await checkToolPreconditions(
      MD_PRE,
      { markdown: `![house](media:${FABRICATED_ID})\n\nThe story.` },
      'o1',
      async () => null,
    );
    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.error).toContain(FABRICATED_ID);
      expect(res.error).toContain('no such node');
      expect(res.error).toContain('Nothing was written');
      expect(res.error).toContain('file#2153d1f2');
      expect(res.error).toContain('file_list / search_nodes');
    }
  });

  it('refuses a non-UUID media id without hitting the lookup', async () => {
    const lookup = vi.fn(async () => 'file');
    const res = await checkToolPreconditions(MD_PRE, { markdown: '![a](media:f-1)' }, 'o1', lookup);
    expect(res?.ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports every bad ref in ONE error, so a bad page costs one retry', async () => {
    const other = '3153d1f2-8b39-4f0a-9c65-6c8b6e7f4e5f';
    const res = await checkToolPreconditions(
      MD_PRE,
      { markdown: `![a](media:${FABRICATED_ID})\n\n[Spec](page:${other})` },
      'o1',
      async () => null,
    );
    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.error).toContain('references 2 ids that do not exist');
      expect(res.error).toContain(`media:${FABRICATED_ID}`);
      expect(res.error).toContain(`page:${other}`);
    }
  });

  it('catches a wrong-type ref (a page id used as an image)', async () => {
    const res = await checkToolPreconditions(
      MD_PRE,
      { markdown: `![a](media:${FILE_ID})` },
      'o1',
      async () => 'page',
    );
    expect(res?.ok).toBe(false);
    if (res && !res.ok) expect(res.error).toContain('that id is a page, not a file');
  });

  it('reads markdown out of an ops array (page_blocks_apply)', async () => {
    const opsPre: readonly ToolPrecondition[] = [
      { kind: 'markdown_refs', param: 'ops', itemKey: 'markdown' },
    ];
    const input = {
      ops: [
        { op: 'delete', block_id: 'b1' },
        { op: 'update', block_id: 'b2', markdown: `![a](media:${FABRICATED_ID})` },
      ],
    };
    const res = await checkToolPreconditions(opsPre, input, 'o1', async () => null);
    expect(res?.ok).toBe(false);
    if (res && !res.ok) expect(res.error).toContain("'ops[].markdown'");
  });

  it('leaves a body with no app-native refs alone', async () => {
    const lookup = vi.fn(async () => 'file');
    const res = await checkToolPreconditions(
      MD_PRE,
      { markdown: '# Title\n\nProse with a [link](https://example.com).' },
      'o1',
      lookup,
    );
    expect(res).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  // ── mermaid_labels ──
  // An unquoted `(` inside a node label kills the whole diagram at parse time.
  // The model can't see the render, so the write must be what tells it.
  const MERMAID_PRE: readonly ToolPrecondition[] = [{ kind: 'mermaid_labels', param: 'markdown' }];
  const BAD_DIAGRAM = '```mermaid\nflowchart TD\n  I --> R[deputy approver (backup)]\n```';

  it('refuses a body whose mermaid label has unquoted parentheses', async () => {
    const res = await checkToolPreconditions(MERMAID_PRE, { markdown: BAD_DIAGRAM }, 'o1');
    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.error).toContain("'markdown'");
      expect(res.error).toContain('R[deputy approver (backup)]');
      expect(res.error).toContain('Nothing was written');
      expect(res.error).toContain('R["deputy approver (backup)"]'); // the fix, spelled out
    }
  });

  it('accepts the quoted form', async () => {
    const res = await checkToolPreconditions(
      MERMAID_PRE,
      { markdown: '```mermaid\nflowchart TD\n  I --> R["deputy approver (backup)"]\n```' },
      'o1',
    );
    expect(res).toBeNull();
  });

  it('names the ops[] path when the bad diagram rides in a block op', async () => {
    const opsPre: readonly ToolPrecondition[] = [
      { kind: 'mermaid_labels', param: 'ops', itemKey: 'markdown' },
    ];
    const res = await checkToolPreconditions(
      opsPre,
      { ops: [{ op: 'append', markdown: BAD_DIAGRAM }] },
      'o1',
    );
    expect(res?.ok).toBe(false);
    if (res && !res.ok) expect(res.error).toContain("'ops[].markdown'");
  });

  it('never touches the node lookup — the mermaid check is pure', async () => {
    const lookup = vi.fn(async () => 'page');
    await checkToolPreconditions(MERMAID_PRE, { markdown: BAD_DIAGRAM }, 'o1', lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});
