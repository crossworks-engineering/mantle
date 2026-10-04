import { describe, expect, it } from 'vitest';
import { finalLine } from './final-line';

describe('finalLine', () => {
  it('says OK and the time on exit 0', () => {
    expect(finalLine('chunk-windows', true, 0, null, 90_000)).toBe(
      'maintain: chunk-windows (LIVE) finished OK in 1.5 min',
    );
    expect(finalLine('deps-drift', false, 0, null, 4_200)).toBe(
      'maintain: deps-drift (dry-run) finished OK in 4 s',
    );
  });

  it('names the exit code on a failure', () => {
    expect(finalLine('re-embed', true, 1, null, 2_000)).toBe(
      'maintain: re-embed (LIVE) FAILED after 2 s: exit 1',
    );
  });

  it('names the signal, with the likely cause for a kill or a heap abort', () => {
    expect(finalLine('chunk-windows', true, null, 'SIGKILL', 600_000)).toContain(
      'killed by SIGKILL (often out of memory',
    );
    expect(finalLine('chunk-windows', true, null, 'SIGABRT', 1_000)).toContain(
      'killed by SIGABRT (often the Node heap limit',
    );
    // tsx reports a killed child as 128 + the signal number.
    expect(finalLine('chunk-windows', true, 137, null, 1_000)).toContain('killed by SIGKILL');
    expect(finalLine('chunk-windows', true, 134, null, 1_000)).toContain('killed by SIGABRT');
    expect(finalLine('chunk-windows', true, null, 'SIGTERM', 1_000)).toMatch(/killed by SIGTERM$/);
  });
});
