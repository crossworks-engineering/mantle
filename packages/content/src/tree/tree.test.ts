import { readdirSync, readFileSync } from 'node:fs';
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
import { TREE_LIVE_KINDS, itemState } from './kinds';

describe('tree cursor', () => {
  it('round-trips and is opaque', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const raw = encodeTreeCursor({ sort: 'name', key: 'acme contract.pdf', id });
    expect(raw).not.toContain('acme');
    expect(decodeTreeCursor(raw, 'name')).toEqual({ sort: 'name', key: 'acme contract.pdf', id });
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

  it('the database depth check names every kind root (its latest definition)', () => {
    // 0201 made it; a later migration may replace it (0204 added recall).
    const dir = join(__dirname, '..', '..', '..', 'db', 'migrations');
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        readFileSync(join(dir, f), 'utf8').includes('"nodes_tree_folder_depth_ck" CHECK'),
      )
      .at(-1)!;
    const sqlText = readFileSync(join(dir, latest), 'utf8');
    expect(sqlText).toContain(`nlevel("path") <= ${TREE_MAX_DEPTH + 1}`);
    for (const k of TREE_KINDS) expect(sqlText).toContain(`'${TREE_KIND_SPECS[k].root}'`);
  });

  it('only live kinds are served, and they are tree kinds', () => {
    for (const k of TREE_LIVE_KINDS) expect(TREE_KINDS).toContain(k);
  });
});

describe('the owner tree row state', () => {
  it('shows a Recall map an agent made as a draft until it is published', () => {
    expect(itemState('recall', { published: false })).toBe('draft');
    expect(itemState('recall', { published: true })).toBeNull();
    // A map written before the flag lived on the item: published.
    expect(itemState('recall', {})).toBeNull();
  });
  it('gives no other kind a state', () => {
    expect(itemState('notes', { published: false })).toBeNull();
  });
});

describe('the tree cursor', () => {
  it('treats a forged id as no cursor instead of failing the query', () => {
    const good = encodeTreeCursor({
      sort: 'name',
      key: 'a',
      id: '11111111-2222-4333-8444-555555555555',
    });
    expect(decodeTreeCursor(good, 'name')).not.toBeNull();
    const forged = Buffer.from(JSON.stringify(['name', 'a', "x' or 1=1"]), 'utf8').toString(
      'base64url',
    );
    expect(decodeTreeCursor(forged, 'name')).toBeNull();
  });
});
