import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ImportPathError, resolveImportPath } from './paths';

/**
 * `sandbox_import` is the only route that turns caller text into a host path,
 * and sandboxd holds the docker socket — an escape here is root on the box, not
 * a bad file in a sandbox. So the traversal cases are pinned explicitly rather
 * than left to "the resolve check probably covers it".
 */
const ROOT = '/data/sandboxes/abc/files';

describe('resolveImportPath keeps the write under /files', () => {
  it('accepts a plain name and a nested path', () => {
    expect(resolveImportPath(ROOT, 'register.accdb').dest).toBe(path.join(ROOT, 'register.accdb'));
    expect(resolveImportPath(ROOT, 'data/in/register.accdb').dest).toBe(
      path.join(ROOT, 'data/in/register.accdb'),
    );
  });

  it('accepts the /files prefix a caller sees in the sandbox', () => {
    // The model reads paths as /files/x inside the container; all three spellings
    // must mean the same destination, or it will guess and get a 400.
    for (const spelling of ['/files/report.pdf', 'files/report.pdf', 'report.pdf']) {
      expect(resolveImportPath(ROOT, spelling).rel).toBe('report.pdf');
    }
  });

  it('refuses traversal, however it is spelled', () => {
    for (const bad of [
      '../escape.txt',
      'a/../../escape.txt',
      'a/b/../../../escape.txt',
      '/etc/cron.d/payload',
      '/files/../../etc/passwd',
    ]) {
      expect(() => resolveImportPath(ROOT, bad), bad).toThrow(ImportPathError);
    }
  });

  it('refuses an empty path and the root itself', () => {
    expect(() => resolveImportPath(ROOT, '')).toThrow(ImportPathError);
    expect(() => resolveImportPath(ROOT, '   ')).toThrow(ImportPathError);
    // `/files` alone names a directory; writing bytes to it would EISDIR at
    // best, so it is refused with a message that says what to pass instead.
    expect(() => resolveImportPath(ROOT, '/files/')).toThrow(ImportPathError);
  });

  it('does not treat a name that merely starts with .. as traversal', () => {
    // `..hidden` is a legal filename; only a whole `..` segment escapes.
    expect(resolveImportPath(ROOT, '..hidden.txt').dest).toBe(path.join(ROOT, '..hidden.txt'));
  });
});
