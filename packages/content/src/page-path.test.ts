import { describe, expect, it } from 'vitest';
import { childPagePath, ltreeLabelFromId } from './page-path';

const UUID = '168d3813-4a45-466c-8964-0df463300f8f';

describe('ltreeLabelFromId', () => {
  it('replaces every hyphen with an underscore', () => {
    expect(ltreeLabelFromId(UUID)).toBe('168d3813_4a45_466c_8964_0df463300f8f');
  });

  it('produces a valid ltree label (only [A-Za-z0-9_])', () => {
    expect(ltreeLabelFromId(UUID)).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

describe('childPagePath', () => {
  it('nests a child under a top-level parent (parent path = "pages")', () => {
    expect(childPagePath('pages', UUID)).toBe(`pages.${ltreeLabelFromId(UUID)}`);
  });

  it('chains for grandchildren (descends from the parent path)', () => {
    const child = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const parentPath = `pages.${ltreeLabelFromId(UUID)}`;
    expect(childPagePath(parentPath, child)).toBe(
      `pages.${ltreeLabelFromId(UUID)}.${ltreeLabelFromId(child)}`,
    );
  });

  it('stays a descendant of the pages root and is itself valid ltree', () => {
    const p = childPagePath('pages', UUID);
    expect(p.startsWith('pages.')).toBe(true);
    expect(p).toMatch(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/);
  });
});
