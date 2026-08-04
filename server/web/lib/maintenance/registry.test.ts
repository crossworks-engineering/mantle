import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MAINTENANCE_TASKS, getTask, isFreeCost, isLiveRun } from './registry';
import { SWEEPS } from './sweeps';

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

  it('cost-safety: schedulable tasks are free, recurring, live, and never mutate unasked', () => {
    for (const t of MAINTENANCE_TASKS.filter((t) => t.schedulable)) {
      // Free means no SPEND: sql and io cost nothing, imap burns mailbox
      // round-trips, embedding/llm are real money.
      expect(['sql', 'io'], t.slug).toContain(t.cost);
      expect(t.kind, t.slug).toBe('recurring');
      expect(t.status, t.slug).toBe('live');
      // Either it defaults to dry-run (and the worker declines to pass the
      // flag), or it cannot write at all. One or the other, never neither.
      expect(Boolean(t.applyFlag || t.readOnly), t.slug).toBe(true);
    }
  });

  it('imap / model-spending tasks are never schedulable', () => {
    const spends = (c: string) => c === 'imap' || c === 'llm' || c === 'embedding';
    for (const t of MAINTENANCE_TASKS.filter((t) => spends(t.cost))) {
      expect(t.schedulable, t.slug).toBe(false);
    }
  });

  it('a readOnly task never declares an applyFlag', () => {
    for (const t of MAINTENANCE_TASKS.filter((t) => t.readOnly)) {
      expect(t.applyFlag, t.slug).toBeUndefined();
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

/**
 * The gap this closes: `schedulable: true` is a claim about the nightly cron,
 * and nothing checked it. `deps-drift` carried that flag from the day it
 * shipped and never ran once — `runScheduledSweeps` dropped it on a stale
 * `cost === 'sql'` check, and then would have dropped it again for having no
 * entry in the in-process SWEEPS map. Both failures are silent by design: the
 * cron logs one console.warn at 03:30 UTC and moves on.
 *
 * So the claim is now enforced at build time in both directions.
 */
describe('schedulable tasks are actually scheduled', () => {
  it('every schedulable task has an in-process sweep', () => {
    // Without this, `schedulable: true` is decoration. The cron never falls
    // back to spawning the script, so a missing entry means it simply never runs.
    for (const t of MAINTENANCE_TASKS.filter((x) => x.schedulable)) {
      expect(Object.keys(SWEEPS), `${t.slug} is schedulable but has no SWEEPS entry`).toContain(
        t.slug,
      );
    }
  });

  it('every sweep belongs to a task the cron will actually reach', () => {
    // The reverse direction: a sweep for a task that is not schedulable, or
    // whose cost the runner bars, is dead code that reads as coverage.
    for (const slug of Object.keys(SWEEPS)) {
      const task = getTask(slug);
      expect(task, `SWEEPS has "${slug}" with no registry task`).toBeDefined();
      expect(task!.schedulable, `${slug} has a sweep but is not schedulable`).toBe(true);
      expect(isFreeCost(task!.cost), `${slug} has a sweep but its cost is barred`).toBe(true);
    }
  });

  it('isFreeCost is the one definition of "free to run unattended"', () => {
    // sql and io cost nothing; the rest are round-trips or real model spend.
    expect(isFreeCost('sql')).toBe(true);
    expect(isFreeCost('io')).toBe(true);
    expect(isFreeCost('imap')).toBe(false);
    expect(isFreeCost('embedding')).toBe(false);
    expect(isFreeCost('llm')).toBe(false);
  });

  it('bars a spending task from ever being marked schedulable', () => {
    for (const t of MAINTENANCE_TASKS.filter((x) => x.schedulable)) {
      expect(isFreeCost(t.cost), `${t.slug} is schedulable but costs ${t.cost}`).toBe(true);
    }
  });
});
