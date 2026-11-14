/**
 * The stamp, read and compared in one place: stampOfMeta, readerIsCurrent,
 * afterIsCurrent and the one form of an entry of `pipelines_after`. Pure.
 */
import { describe, expect, it } from 'vitest';
import { AFTER_PIPELINES, builtinForExt } from './builtin';
import {
  afterEntryOf,
  afterIsCurrent,
  readerIsCurrent,
  stampOfMeta,
  withAfterEntry,
} from './stamp';

const cad = builtinForExt('dxf')!;
const site = AFTER_PIPELINES.find((p) => p.id === 'site-tags')!;
const FOUR = {
  pipeline_id: 'drawing-cad',
  pipeline_version: '1.0.0',
  pipeline_api: '1',
  shapes: '',
};

describe('stampOfMeta', () => {
  it('the four keys of phase 1, and the two new ones only when there', () => {
    expect(stampOfMeta(FOUR)).toEqual(FOUR);
    expect(Object.keys(stampOfMeta(FOUR)!)).toEqual(Object.keys(FOUR));
    expect(
      stampOfMeta({ ...FOUR, pipeline_options: '0a1b2c3d', pipelines_after: 'site-tags@1.0.0' }),
    ).toEqual({ ...FOUR, pipeline_options: '0a1b2c3d', pipelines_after: 'site-tags@1.0.0' });
  });
  it('null before stamps: no meta, or one of the four missing', () => {
    expect(stampOfMeta(null)).toBeNull();
    expect(stampOfMeta({})).toBeNull();
    expect(stampOfMeta({ ...FOUR, shapes: undefined } as never)).toBeNull();
    expect(stampOfMeta({ pipelines_after: 'site-tags@1.0.0' })).toBeNull();
  });
});

describe('readerIsCurrent', () => {
  it('missing, another reader, a lower version or other options: not current', () => {
    expect(readerIsCurrent(null, cad, '')).toBe(false);
    expect(readerIsCurrent({ ...FOUR, pipeline_id: 'sheet' }, cad, '')).toBe(false);
    expect(readerIsCurrent({ ...FOUR, pipeline_version: '0.9.0' }, cad, '')).toBe(false);
    expect(readerIsCurrent({ ...FOUR, pipeline_options: '0a1b2c3d' }, cad, '')).toBe(false);
    expect(readerIsCurrent(FOUR, cad, '0a1b2c3d')).toBe(false);
  });
  it('the same reader, at its version or higher, with the same options: current', () => {
    expect(readerIsCurrent(FOUR, cad, '')).toBe(true);
    expect(readerIsCurrent({ ...FOUR, pipeline_version: '2.0.0' }, cad, '')).toBe(true);
    expect(readerIsCurrent({ ...FOUR, pipeline_options: 'abcd0123' }, cad, 'abcd0123')).toBe(true);
  });
});

describe('the after entry', () => {
  it('is id@version, with #hash only when the options are not all defaults', () => {
    expect(afterEntryOf(site, '')).toBe('site-tags@1.0.0');
    expect(afterEntryOf(site, '0a1b2c3d')).toBe('site-tags@1.0.0#0a1b2c3d');
  });

  it('withAfterEntry keeps the other entries in place and replaces its own', () => {
    expect(withAfterEntry(undefined, site, '')).toBe('site-tags@1.0.0');
    expect(withAfterEntry('', site, 'ab')).toBe('site-tags@1.0.0#ab');
    expect(withAfterEntry('other@2.0.0', site, '')).toBe('other@2.0.0,site-tags@1.0.0');
    expect(withAfterEntry('a@1.0.0,site-tags@0.9.0#ff,b@1.0.0', site, '')).toBe(
      'a@1.0.0,site-tags@1.0.0,b@1.0.0',
    );
    // A double of its own (a hand edit) goes; a prefix of another id stays.
    expect(withAfterEntry('site-tags@0.1.0,site-tagsx@1.0.0,site-tags@0.2.0', site, '')).toBe(
      'site-tags@1.0.0,site-tagsx@1.0.0',
    );
  });

  it('afterIsCurrent: the entry is there, not lower, with the same options', () => {
    expect(afterIsCurrent(null, site, '')).toBe(false);
    expect(afterIsCurrent({}, site, '')).toBe(false);
    expect(afterIsCurrent(FOUR, site, '')).toBe(false);
    expect(afterIsCurrent({ pipelines_after: 'site-tags@1.0.0' }, site, '')).toBe(true);
    expect(afterIsCurrent({ pipelines_after: 'x@1.0.0,site-tags@1.2.0' }, site, '')).toBe(true);
    expect(afterIsCurrent({ pipelines_after: 'site-tags@0.9.0' }, site, '')).toBe(false);
    expect(afterIsCurrent({ pipelines_after: 'site-tags@1.0.0' }, site, 'ab')).toBe(false);
    expect(afterIsCurrent({ pipelines_after: 'site-tags@1.0.0#ab' }, site, 'ab')).toBe(true);
    expect(afterIsCurrent({ pipelines_after: 'site-tags@1.0.0#ab' }, site, '')).toBe(false);
    expect(afterIsCurrent({ pipelines_after: 'site-tagsx@1.0.0' }, site, '')).toBe(false);
    // What withAfterEntry writes is current for the same options.
    expect(
      afterIsCurrent({ pipelines_after: withAfterEntry('a@1.0.0', site, 'cd') }, site, 'cd'),
    ).toBe(true);
  });
});
