/**
 * TREE_TOOL_KINDS is derived from the kind registry (workspaces arch A1):
 * the live tree kinds but Files. Pinned in order (it is the `kind` enum of
 * the tree tools' schema) to its value before the registry.
 */
import { describe, expect, it } from 'vitest';
import { TREE_TOOL_KINDS } from './builtins-tree';

describe('TREE_TOOL_KINDS', () => {
  it('keeps its value and order', () => {
    expect(TREE_TOOL_KINDS).toEqual([
      'notes',
      'pages',
      'draw',
      'tables',
      'formulas',
      'tasks',
      'events',
      'contacts',
      'secrets',
      'apps',
      'recall',
      // Present, appended.
      'present',
    ]);
  });
});
