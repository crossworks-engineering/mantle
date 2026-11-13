import { describe, expect, it } from 'vitest';
import { builtinForExt } from '@mantle/files';
import { readByOlder } from './pipeline-reread';

describe('pipeline-reread: the stamp compare', () => {
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
