/**
 * The host's own load and memory from a mounted host /proc (MANTLE_HOST_PROC,
 * host-proc.ts): the two files parse to numbers, and a file that is missing
 * or does not parse is no answer, never a guess.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLoadavg, parseMeminfo, readHostProc } from './host-proc';

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1024000 kB
MemAvailable:   12288000 kB
Buffers:          102400 kB
`;

describe('host /proc', () => {
  it('parses loadavg', () => {
    expect(parseLoadavg('0.52 0.41 0.30 2/812 12345\n')).toEqual([0.52, 0.41, 0.3]);
    expect(parseLoadavg('')).toBeNull();
    expect(parseLoadavg('a b c')).toBeNull();
  });

  it('parses meminfo: used is total less available', () => {
    const m = parseMeminfo(MEMINFO)!;
    expect(m.totalBytes).toBe(16384000 * 1024);
    expect(m.usedBytes).toBe((16384000 - 12288000) * 1024);
    expect(m.usedPct).toBeCloseTo(25, 5);
    expect(parseMeminfo('MemTotal: 10 kB\n')).toBeNull();
    expect(parseMeminfo('MemTotal: 10 kB\nMemAvailable: 20 kB\n')).toBeNull();
  });

  it('reads a mounted directory, and answers null when a file is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'host-proc-'));
    try {
      await writeFile(path.join(dir, 'loadavg'), '1.00 2.00 3.00 1/100 1\n');
      expect(await readHostProc(dir)).toBeNull();
      await writeFile(path.join(dir, 'meminfo'), MEMINFO);
      expect(await readHostProc(dir)).toMatchObject({ loadAvg: [1, 2, 3] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
