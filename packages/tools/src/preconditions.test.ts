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
