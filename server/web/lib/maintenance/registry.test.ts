import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MAINTENANCE_TASKS, getTask, isLiveRun } from './registry';

// apps/web/lib/maintenance → repo root is four levels up.
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('maintenance registry', () => {
  it('has unique slugs', () => {
    const slugs = MAINTENANCE_TASKS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every script path exists on disk', () => {
    for (const t of MAINTENANCE_TASKS) {
      const path = join(REPO_ROOT, t.cwd, t.script);
      expect(existsSync(path), `${t.slug} → ${t.cwd}/${t.script}`).toBe(true);
    }
  });

  it('cost-safety: schedulable tasks are free, recurring, live, dry-run-by-default', () => {
    for (const t of MAINTENANCE_TASKS.filter((t) => t.schedulable)) {
      expect(t.cost, t.slug).toBe('sql');
      expect(t.kind, t.slug).toBe('recurring');
      expect(t.status, t.slug).toBe('live');
      expect(t.applyFlag, t.slug).toBeTruthy();
    }
  });

  it('model-spending tasks are never schedulable', () => {
    for (const t of MAINTENANCE_TASKS.filter((t) => t.cost === 'llm' || t.cost === 'embedding')) {
      expect(t.schedulable, t.slug).toBe(false);
    }
  });

  it('no task declares both applyFlag and dryRunFlag', () => {
    for (const t of MAINTENANCE_TASKS) {
      expect(Boolean(t.applyFlag && t.dryRunFlag), t.slug).toBe(false);
    }
  });

  it('getTask resolves known slugs and rejects unknown ones', () => {
    expect(getTask('entities-dedupe')?.script).toBe('scripts/entities-dedupe.ts');
    expect(getTask('nope')).toBeUndefined();
  });

  it('isLiveRun follows each flag convention', () => {
    const applyTask = getTask('entities-dedupe')!; // dry-run default, --go applies
    expect(isLiveRun(applyTask, [])).toBe(false);
    expect(isLiveRun(applyTask, ['--go'])).toBe(true);

    const dryFlagTask = getTask('re-embed')!; // live default, --dry-run opts out
    expect(isLiveRun(dryFlagTask, [])).toBe(true);
    expect(isLiveRun(dryFlagTask, ['--dry-run'])).toBe(false);

    const bareTask = getTask('rotate-master-key')!; // no convention — always live
    expect(isLiveRun(bareTask, [])).toBe(true);
  });
});
