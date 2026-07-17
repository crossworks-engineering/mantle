import { describe, expect, it } from 'vitest';
import { classifyDriveItem } from './classify';
import type { DriveItem } from './types';

/**
 * The drive-sync per-item verdict — the create/update/DELETE fork that decides
 * what a Graph delta page does to the brain. Every branch that can REMOVE a node
 * (tombstone, out-of-scope prune) is pinned here, plus the skip/ingest gates,
 * in the exact precedence `syncDrive` relies on. Pure; no DB.
 */

const MAX = 25 * 1024 * 1024;

/** A minimal live file item at an in-scope-by-default path. */
function file(overrides: Partial<DriveItem> = {}): DriveItem {
  return {
    id: 'item-1',
    name: 'report.pdf',
    eTag: 'etag-1',
    size: 1024,
    file: { mimeType: 'application/pdf' },
    parentReference: { path: '/drives/d1/root:/Reports' },
    ...overrides,
  };
}

describe('classifyDriveItem', () => {
  it('skips the drive root without counting it (no scope needed)', () => {
    expect(classifyDriveItem({ id: 'r', root: {} } as DriveItem, [], MAX)).toBe('skip-root');
  });

  it('removes a tombstone', () => {
    expect(classifyDriveItem({ id: 'x', deleted: { state: 'deleted' } }, [], MAX)).toBe(
      'remove-deleted',
    );
  });

  it('treats a tombstone as a removal even when it still carries a folder facet', () => {
    // A `deleted` item may arrive with or without facets — deletion wins over
    // the folder-skip so we never leak a delete into a silent skip.
    const item: DriveItem = { id: 'x', deleted: { state: 'deleted' }, folder: { childCount: 0 } };
    expect(classifyDriveItem(item, [], MAX)).toBe('remove-deleted');
  });

  it('skips folders and non-file packages (flat v1 layout)', () => {
    expect(classifyDriveItem({ id: 'f', folder: { childCount: 3 } }, [], MAX)).toBe('skip-nonfile');
    // No folder facet, no file facet → a package (e.g. a OneNote notebook).
    expect(classifyDriveItem({ id: 'p', name: 'notebook' }, [], MAX)).toBe('skip-nonfile');
  });

  it('ingests a normal in-scope file', () => {
    expect(classifyDriveItem(file(), [], MAX)).toBe('consider');
  });

  it('removes a live file that falls outside the saved folder scope', () => {
    const scopes = [{ itemId: 'f1', path: '/Reports', isFolder: true }];
    // Under the scoped folder → ingest.
    expect(
      classifyDriveItem(
        file({ parentReference: { path: '/drives/d1/root:/Reports' } }),
        scopes,
        MAX,
      ),
    ).toBe('consider');
    // A sibling folder → pruned, not silently skipped (this is the destructive
    // branch: it deletes a previously-ingested node that left the selection).
    expect(
      classifyDriveItem(file({ parentReference: { path: '/drives/d1/root:/Other' } }), scopes, MAX),
    ).toBe('remove-out-of-scope');
  });

  it('keeps a file selected by id even after it is moved/renamed out of its folder', () => {
    const scopes = [{ itemId: 'keep-me', path: '/Standalone/keep.pdf', isFolder: false }];
    const moved = file({
      id: 'keep-me',
      name: 'renamed.pdf',
      parentReference: { path: '/drives/d1/root:/Elsewhere' },
    });
    expect(classifyDriveItem(moved, scopes, MAX)).toBe('consider');
  });

  it('scope prune takes precedence over the oversize skip', () => {
    // An out-of-scope file that is ALSO oversized must be removed (pruned), not
    // merely skipped — otherwise a stale in-brain copy would survive re-scoping.
    const scopes = [{ itemId: 'f1', path: '/Reports', isFolder: true }];
    const big = file({ parentReference: { path: '/drives/d1/root:/Other' }, size: MAX + 1 });
    expect(classifyDriveItem(big, scopes, MAX)).toBe('remove-out-of-scope');
  });

  it('skips an in-scope file that exceeds the byte cap', () => {
    expect(classifyDriveItem(file({ size: MAX + 1 }), [], MAX)).toBe('skip-oversize');
    // Exactly at the cap is allowed through.
    expect(classifyDriveItem(file({ size: MAX }), [], MAX)).toBe('consider');
  });

  it('ingests a file with no declared size (size gate only fires on a number)', () => {
    expect(classifyDriveItem(file({ size: undefined }), [], MAX)).toBe('consider');
  });
});
