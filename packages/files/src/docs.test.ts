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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectionRoot,
  diffDocSets,
  docsRoot,
  effectiveBrainDepth,
  isHiddenDocRelPath,
  listMarkdownRelPaths,
  ltreeForDocPath,
} from './docs';

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

describe('isHiddenDocRelPath', () => {
  it('flags `_`-prefixed segments (the archive convention)', () => {
    expect(isHiddenDocRelPath('_archive/handoff.md')).toBe(true);
    expect(isHiddenDocRelPath('a/_drafts/x.md')).toBe(true);
  });

  it('flags dot-prefixed segments', () => {
    expect(isHiddenDocRelPath('.hidden/x.md')).toBe(true);
  });

  it('allows normal paths', () => {
    expect(isHiddenDocRelPath('guide/00-index.md')).toBe(false);
    expect(isHiddenDocRelPath('architecture.md')).toBe(false);
  });
});

describe('listMarkdownRelPaths', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mantle-docs-walk-'));
    await fs.mkdir(path.join(tmp, '_archive'), { recursive: true });
    await fs.mkdir(path.join(tmp, '.hidden'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'top.md'), '# top');
    await fs.writeFile(path.join(tmp, 'sub', 'nested.md'), '# nested');
    await fs.writeFile(path.join(tmp, '_archive', 'old.md'), '# old');
    await fs.writeFile(path.join(tmp, '.hidden', 'secret.md'), '# secret');
    await fs.writeFile(path.join(tmp, 'notes.txt'), 'not markdown');
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('lists markdown, sorted, excluding `_`/dot dirs and non-md files', async () => {
    expect(await listMarkdownRelPaths(tmp)).toEqual(['sub/nested.md', 'top.md']);
  });

  it('returns [] for a missing root', async () => {
    expect(await listMarkdownRelPaths(path.join(tmp, 'does-not-exist'))).toEqual([]);
  });

  it('walks a root that is ITSELF a `_`-dir (the changelog collection shape)', async () => {
    // The hidden convention applies to segments relative to the collection root,
    // not to the root's own name — a collection rooted AT `_changelog` indexes.
    expect(await listMarkdownRelPaths(path.join(tmp, '_archive'))).toEqual(['old.md']);
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
