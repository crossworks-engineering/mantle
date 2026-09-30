import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TREE_FOLDER_NAME_MAX,
  TREE_KIND_SPECS,
  TREE_KINDS,
  TREE_MAX_DEPTH,
} from '@mantle/client-types/tree';
import { FILES_MAX_FOLDER_DEPTH, FOLDER_NAME_MAX } from '@mantle/files';
import { decodeTreeCursor, encodeTreeCursor } from './cursor';
import { TREE_LIVE_KINDS } from './kinds';

describe('tree cursor', () => {
  it('round-trips and is opaque', () => {
    const raw = encodeTreeCursor({ sort: 'name', key: 'acme contract.pdf', id: 'abc' });
    expect(raw).not.toContain('acme');
    expect(decodeTreeCursor(raw, 'name')).toEqual({
      sort: 'name',
      key: 'acme contract.pdf',
      id: 'abc',
    });
  });

  it('restarts on a cursor for another sort or a malformed one', () => {
    const raw = encodeTreeCursor({ sort: 'name', key: 'a', id: 'b' });
    expect(decodeTreeCursor(raw, 'updated')).toBeNull();
    expect(decodeTreeCursor('not-a-cursor', 'name')).toBeNull();
    expect(decodeTreeCursor('', 'name')).toBeNull();
    expect(decodeTreeCursor(null, 'name')).toBeNull();
  });
});

describe('the tree limits agree everywhere', () => {
  it('the Files package uses the tree depth and name limits', () => {
    expect(FILES_MAX_FOLDER_DEPTH).toBe(TREE_MAX_DEPTH);
    expect(FOLDER_NAME_MAX).toBe(TREE_FOLDER_NAME_MAX);
  });

  it('the database depth check names every kind root (migration 0199)', () => {
    const sqlText = readFileSync(
      join(__dirname, '..', '..', '..', 'db', 'migrations', '0199_item_tree.sql'),
      'utf8',
    );
    expect(sqlText).toContain(`nlevel("path") <= ${TREE_MAX_DEPTH + 1}`);
    for (const k of TREE_KINDS) expect(sqlText).toContain(`'${TREE_KIND_SPECS[k].root}'`);
  });

  it('only live kinds are served, and they are tree kinds', () => {
    for (const k of TREE_LIVE_KINDS) expect(TREE_KINDS).toContain(k);
  });
});
