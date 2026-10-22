/** narrowNeedsSpot: which writes need their caller's full-route spot. */
import { describe, expect, it } from 'vitest';
import {
  agentGroups,
  agents,
  calendarAccounts,
  curatedModels,
  embeddingConfig,
  msDrives,
} from './schema';
import { insertTurnsOn, narrowNeedsSpot } from './narrow-writes';

describe('narrowNeedsSpot', () => {
  it('an insert that starts a switch on, named or by its default, needs the spot (0324)', () => {
    // calendar_accounts.enabled defaults to true; ms_drives.enabled to false.
    expect(insertTurnsOn(calendarAccounts, { enabled: true })).toBe(true);
    expect(insertTurnsOn(calendarAccounts, {})).toBe(true);
    expect(insertTurnsOn(calendarAccounts, { enabled: false })).toBe(false);
    expect(insertTurnsOn(msDrives, {})).toBe(false);
    expect(narrowNeedsSpot(calendarAccounts, 'insert', { enabled: true })).toBe(true);
    expect(narrowNeedsSpot(calendarAccounts, 'insert', { enabled: false })).toBe(false);
  });

  it('the destination and cost class needs model-route; a name or a switch off does not', () => {
    for (const set of [
      { provider: 'x' },
      { model: 'x' },
      { backupProvider: 'x' },
      { backupModel: 'x' },
      { thinkingEffort: 'high' },
    ])
      expect(narrowNeedsSpot(agents, 'update', set), JSON.stringify(set)).toBe(true);
    expect(narrowNeedsSpot(agents, 'update', { name: 'x', updatedAt: new Date() })).toBe(false);
    expect(narrowNeedsSpot(embeddingConfig, 'update', { extractionConcurrency: 4 })).toBe(true);
    expect(narrowNeedsSpot(embeddingConfig, 'update', { backupEnabled: false })).toBe(false);
    expect(narrowNeedsSpot(curatedModels, 'insert')).toBe(true);
    expect(narrowNeedsSpot(curatedModels, 'delete')).toBe(true);
    expect(narrowNeedsSpot(agentGroups, 'update', { memberSlugs: [] })).toBe(true);
  });
});
