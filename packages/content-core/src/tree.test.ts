import { describe, expect, it } from 'vitest';
import { TREE_KIND_SPECS, TREE_KINDS, TREE_MAX_DEPTH } from '@mantle/client-types/tree';
import {
  clampTreePath,
  isTreeFolderPathAllowed,
  treeDepth,
  treeFolderChain,
  treeKindOfPath,
  treeMoveDepth,
  treeParentPath,
} from './tree';

describe('tree path math', () => {
  it('finds the kind from the root label', () => {
    expect(treeKindOfPath('files.clients.acme')).toBe('files');
    expect(treeKindOfPath('draw')).toBe('draw');
    expect(treeKindOfPath('documentation.x')).toBeNull();
    expect(treeKindOfPath('')).toBeNull();
  });

  it('measures depth below the root', () => {
    expect(treeDepth('files')).toBe(0);
    expect(treeDepth('files.a')).toBe(1);
    expect(treeDepth('files.a.b.c')).toBe(3);
  });

  it('walks parents and the folder chain', () => {
    expect(treeParentPath('files.a.b')).toBe('files.a');
    expect(treeParentPath('files')).toBe('files');
    expect(treeFolderChain('files.a.b')).toEqual(['files.a', 'files.a.b']);
    expect(treeFolderChain('files')).toEqual([]);
  });

  it('allows folders at depth 1..3 only', () => {
    expect(isTreeFolderPathAllowed('files')).toBe(false);
    expect(isTreeFolderPathAllowed('files.a')).toBe(true);
    expect(isTreeFolderPathAllowed('files.a.b.c')).toBe(true);
    expect(isTreeFolderPathAllowed('files.a.b.c.d')).toBe(false);
  });

  it('clamps a deep path into the third level', () => {
    expect(clampTreePath('files.a.b.c.d.e')).toBe('files.a.b.c');
    expect(clampTreePath('files.a')).toBe('files.a');
  });

  it('measures a moved subtree', () => {
    expect(treeMoveDepth('files.a', 2)).toBe(3);
    expect(treeMoveDepth('files.a.b', 2)).toBeGreaterThan(TREE_MAX_DEPTH);
  });

  it('has one spec per kind with distinct roots', () => {
    const roots = TREE_KINDS.map((k) => TREE_KIND_SPECS[k].root);
    expect(new Set(roots).size).toBe(TREE_KINDS.length);
    for (const k of TREE_KINDS) {
      expect(TREE_KIND_SPECS[k].kind).toBe(k);
      expect(TREE_KIND_SPECS[k].sorts.length).toBeGreaterThan(0);
    }
  });
});
