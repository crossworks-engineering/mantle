/**
 * The static narrow write scan (plan v3.2 S7b part b2 round 12, the full
 * audit's app MED-1): every drizzle write of the source on a table that is
 * not a content table is allowed by the narrow role's allowlist, sits at a
 * full-route spot, is in a file that never runs on a narrow exit, or is
 * pinned open (a list that only shrinks).
 */
import { describe, expect, it } from 'vitest';
import * as schema from './schema';
import { narrowAllows, scanRepo, scanSource, tablesOf, writeKey } from './narrow-write-scan';
import { NARROW_SCAN_OPEN, NARROW_SCAN_SYSTEM_FILES } from './narrow-write-scan.pins';

const repo = new URL('../../..', import.meta.url).pathname;
const tables = tablesOf(schema as Record<string, unknown>);

describe('the static narrow write scan', () => {
  const found = scanRepo(repo, ['server', 'packages'], tables);
  const keys = [...new Set(found.map(writeKey))].sort();

  it('every write the allowlist does not hold is at a spot, system only, or pinned open', () => {
    const unheld = keys.filter(
      (k) => !NARROW_SCAN_SYSTEM_FILES[k.split(' ')[0]!] && !NARROW_SCAN_OPEN.includes(k),
    );
    expect(unheld).toEqual([]);
  });

  it('the pins are exact: every open entry and system file is still found (the list only shrinks)', () => {
    expect(NARROW_SCAN_OPEN.filter((k) => !keys.includes(k))).toEqual([]);
    const files = new Set(keys.map((k) => k.split(' ')[0]!));
    expect(Object.keys(NARROW_SCAN_SYSTEM_FILES).filter((f) => !files.has(f))).toEqual([]);
    for (const why of Object.values(NARROW_SCAN_SYSTEM_FILES))
      expect(why.length).toBeGreaterThan(15);
    // Round 12's count: down only.
    expect(NARROW_SCAN_OPEN.length).toBeLessThanOrEqual(103);
  });

  it('reads a chain: a spot, a function passed to one, an upsert, a spread, comments and strings', () => {
    const src = `
      // db.update(heartbeats).set({ createdBy: x }) in a comment
      const s = 'db.delete(skills)';
      await db.update(heartbeats).set({ createdBy: x, updatedAt: now }).where(w);
      await onFullSystemRoute('heartbeat-maker', () => db.update(heartbeats).set({ schedule: s }));
      const write = () => db.update(skills).set({ instructions: t });
      await onFullSystemRoute('skill-text', write);
      await db.insert(pushPrefs).values(v).onConflictDoUpdate({ target: pushPrefs.id, set: { approvals: true } });
      await db.update(agents).set({ ...patch, updatedAt: now });
      await db.update(nodes).set({ title: 'x' });
    `;
    const w = scanSource('x.ts', src, tables);
    expect(w.map((x) => [x.table, x.op, x.columns.join(','), x.atSpot])).toEqual([
      ['public.heartbeats', 'update', 'created_by,updated_at', false],
      ['public.heartbeats', 'update', 'schedule', true],
      ['public.skills', 'update', 'instructions', true],
      ['public.push_prefs', 'insert', 'approvals', false],
      ['public.agents', 'update', '*,updated_at', false],
    ]);
    expect(w.map(narrowAllows)).toEqual([false, false, false, true, false]);
  });

  it('round 12 found the Studio commit, the connectors edit and the reflector off their spot; they are at it now', () => {
    for (const f of [
      'server/web/lib/studio/prompt-versions.ts',
      'server/web/lib/mcp-connectors.ts',
      'server/web/lib/openapi-connectors.ts',
      'server/api/src/agent/reflector.ts',
      'server/web/lib/agent-telegram.ts',
      'packages/email/src/accounts.ts',
      'packages/microsoft/src/outlook/manage.ts',
    ])
      expect(
        keys.filter((k) => k.startsWith(`${f} `)),
        f,
      ).toEqual([]);
  });
});
