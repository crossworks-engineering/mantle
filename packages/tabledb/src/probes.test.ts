import { describe, expect, it } from 'vitest';

import { runTableStorageProbes } from './probes';

/**
 * Behavior-pinned foundations of Tables v2 (plan §2). These run on every CI
 * branch (host Node 24 — same major as the prod image) and, via probes-cli,
 * inside the prod image itself on release. A failure here means node:sqlite
 * drifted under us — fix the engine assumption before anything else.
 */
describe('table-storage probes', () => {
  it('every required probe passes, each pinning one engine behavior', async () => {
    const report = await runTableStorageProbes();
    for (const r of report.results.filter((x) => x.required)) {
      expect.soft(r.ok, `${r.key}: ${r.detail}`).toBe(true);
    }
    expect(report.ok, 'required probe set').toBe(true);
    const keys = report.results.map((r) => r.key);
    expect(keys).toEqual([
      'readonly_blocks_writes',
      'wal_persists',
      'fts5_trigram_like',
      'fts5_match_hyphen_quoting',
      'vacuum_into_wal_snapshot',
      'backup_api_present',
    ]);
  });
});
