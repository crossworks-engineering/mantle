import { describe, expect, it } from 'vitest';
import { builtinForExt } from '@mantle/files';
import { readByOlder, versionBelow } from './pipeline-reread';

describe('pipeline-reread: the stamp compare', () => {
  it('compares versions as numbers, not as text', () => {
    expect(versionBelow('1.9.0', '1.10.0')).toBe(true);
    expect(versionBelow('1.10.0', '1.9.0')).toBe(false);
    expect(versionBelow('1.0.0', '1.0.0')).toBe(false);
    expect(versionBelow('0.9.9', '1.0.0')).toBe(true);
    expect(versionBelow('2.0.0', '1.99.99')).toBe(false);
    expect(versionBelow('1.0.9', '1.0.10')).toBe(true);
  });

  it('a version that is not x.y.z is lower', () => {
    expect(versionBelow('', '1.0.0')).toBe(true);
    expect(versionBelow('1.0', '1.0.0')).toBe(true);
    expect(versionBelow('v1.0.0', '1.0.0')).toBe(true);
  });

  it('takes a missing stamp, another pipeline, or a lower version; leaves the rest', () => {
    const sheet = builtinForExt('csv')!;
    const stamp = (id: string, version: string) => ({
      pipeline_id: id,
      pipeline_version: version,
      pipeline_api: '1',
      shapes: '',
    });
    expect(readByOlder(null, sheet)).toBe(true);
    expect(readByOlder(stamp('plan-mspdi', sheet.version), sheet)).toBe(true);
    expect(readByOlder(stamp(sheet.id, '0.0.1'), sheet)).toBe(true);
    expect(readByOlder(stamp(sheet.id, sheet.version), sheet)).toBe(false);
    expect(readByOlder(stamp(sheet.id, '99.0.0'), sheet)).toBe(false);
  });
});
