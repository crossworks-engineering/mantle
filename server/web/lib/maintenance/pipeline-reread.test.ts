import { describe, expect, it } from 'vitest';
import { builtinForExt } from '@mantle/files';
import { BAD_LIMIT } from './dwg-reindex';
import { readByOlder, runPipelineReread } from './pipeline-reread';

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

describe('pipeline-reread: the limit', () => {
  it('refuses --limit=0, a negative number and no number with exit code 2, before any read', async () => {
    for (const asked of ['0', '-1', 'all']) {
      const lines: string[] = [];
      const code = await runPipelineReread(
        ['--pipeline=sheet', `--limit=${asked}`, '--apply'],
        (l) => lines.push(l),
      );
      expect(code, asked).toBe(2);
      expect(lines, asked).toEqual([`[pipeline-reread] ${BAD_LIMIT}`]);
    }
  });
});
