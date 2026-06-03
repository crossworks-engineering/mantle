/**
 * Tests for the pure pieces of the docs sync engine — the path mapping (which
 * must reject `..` traversal like the files layer), the sha-diff classifier
 * (including the empty-root deletion guard that stops a misconfigured
 * MANTLE_DOCS_ROOT from wiping an indexed collection), and the brain-depth gate
 * that keeps system-meta out of L4.
 *
 * Only pure functions are exercised — no DB. `db` in @mantle/db is a lazy Proxy
 * (initialises on first property access), so importing ./docs is safe without a
 * DATABASE_URL.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { collectionRoot, diffDocSets, docsRoot, effectiveBrainDepth, ltreeForDocPath } from './docs';

const ROOT = path.resolve('/tmp/mantle-docs-test-root');

describe('ltreeForDocPath', () => {
  it('maps a top-level doc to the documentation root', () => {
    const loc = ltreeForDocPath(path.join(ROOT, 'architecture.md'), ROOT);
    expect(loc).toEqual({
      parentPath: 'documentation',
      filename: 'architecture.md',
      relPath: 'architecture.md',
    });
  });

  it('maps a nested doc to a documentation.<dir> branch', () => {
    const loc = ltreeForDocPath(path.join(ROOT, 'future', 'industrial-fork.md'), ROOT);
    expect(loc).toEqual({
      parentPath: 'documentation.future',
      filename: 'industrial-fork.md',
      relPath: 'future/industrial-fork.md',
    });
  });

  it('converts dashes in directory names to underscores for ltree labels', () => {
    const loc = ltreeForDocPath(path.join(ROOT, 'how-to', 'x.md'), ROOT);
    expect(loc?.parentPath).toBe('documentation.how_to');
    expect(loc?.relPath).toBe('how-to/x.md'); // relPath keeps the on-disk name
  });

  it('rejects a path that escapes the root via traversal', () => {
    expect(ltreeForDocPath(path.join(ROOT, '..', 'secrets.md'), ROOT)).toBeNull();
    expect(ltreeForDocPath('/etc/passwd', ROOT)).toBeNull();
  });
});

describe('diffDocSets', () => {
  it('classifies new, changed, unchanged, and deleted', () => {
    const disk = { 'a.md': 'sha-a', 'b.md': 'sha-b2', 'c.md': 'sha-c' };
    const db = { 'a.md': 'sha-a', 'b.md': 'sha-b1', 'd.md': 'sha-d' };
    const { toUpsert, toDelete } = diffDocSets(disk, db);
    // a unchanged (skip), b changed, c new → upsert b + c; d gone → delete.
    expect(toUpsert.sort()).toEqual(['b.md', 'c.md']);
    expect(toDelete).toEqual(['d.md']);
  });

  it('upserts everything when the DB is empty', () => {
    const { toUpsert, toDelete } = diffDocSets({ 'a.md': '1', 'b.md': '2' }, {});
    expect(toUpsert.sort()).toEqual(['a.md', 'b.md']);
    expect(toDelete).toEqual([]);
  });

  it('NEVER deletes when the disk set is empty (empty-root guard)', () => {
    const db = { 'a.md': '1', 'b.md': '2' };
    const { toUpsert, toDelete } = diffDocSets({}, db);
    expect(toUpsert).toEqual([]);
    expect(toDelete).toEqual([]); // the guard: a blank root must not wipe the collection
  });
});

describe('collectionRoot', () => {
  it('falls back to the docs root when root_path is null (system collection)', () => {
    expect(collectionRoot({ rootPath: null })).toBe(docsRoot());
  });

  it('resolves a relative root_path against the docs root (portable, repo-shipped)', () => {
    expect(collectionRoot({ rootPath: 'guide' })).toBe(path.join(docsRoot(), 'guide'));
    expect(collectionRoot({ rootPath: 'a/b' })).toBe(path.join(docsRoot(), 'a', 'b'));
  });

  it('uses an absolute root_path as-is (external dir)', () => {
    const abs = path.resolve('/srv/vault');
    expect(collectionRoot({ rootPath: abs })).toBe(abs);
  });
});

describe('effectiveBrainDepth', () => {
  it('defaults documentation to retrieval-only', () => {
    expect(effectiveBrainDepth('documentation', undefined)).toBe('retrieval');
    expect(effectiveBrainDepth('documentation', 'retrieval')).toBe('retrieval');
  });

  it('honours an explicit full depth for documentation', () => {
    expect(effectiveBrainDepth('documentation', 'full')).toBe('full');
  });

  it('always returns full for non-documentation types', () => {
    expect(effectiveBrainDepth('note', 'retrieval')).toBe('full');
    expect(effectiveBrainDepth('file', undefined)).toBe('full');
    expect(effectiveBrainDepth('email', 'retrieval')).toBe('full');
  });
});
