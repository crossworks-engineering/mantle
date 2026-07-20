import { describe, expect, it } from 'vitest';
import { getTask } from './registry';
import { planRun } from './run-args';

const ENV = { ALLOWED_USER_ID: 'u1', MANTLE_MASTER_KEY: 'k' };

describe('planRun', () => {
  it('dry-run default for applyFlag tasks; --apply maps to the script flag', () => {
    const t = getTask('entities-dedupe')!;
    const dry = planRun(t, { apply: false }, ENV);
    expect(dry).toEqual({ ok: true, args: [], live: false });
    const live = planRun(t, { apply: true }, ENV);
    expect(live).toEqual({ ok: true, args: ['--go'], live: true });
  });

  it('dryRunFlag tasks: preview passes the flag, live omits it', () => {
    const t = getTask('re-embed')!;
    const dry = planRun(t, { apply: false }, ENV);
    expect(dry).toEqual({ ok: true, args: ['--dry-run'], live: false });
  });

  it('spend brake: live llm/embedding runs need confirmSpend', () => {
    const t = getTask('re-embed')!;
    const blocked = planRun(t, { apply: true }, ENV);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.status).toBe(403);
    const confirmed = planRun(t, { apply: true, confirmSpend: true }, ENV);
    expect(confirmed).toEqual({ ok: true, args: [], live: true });
  });

  it('retired brake: needs forceRetired', () => {
    const t = getTask('backfill-block-ids')!;
    const blocked = planRun(t, { apply: false }, ENV);
    expect(blocked.ok).toBe(false);
    const forced = planRun(t, { apply: false, forceRetired: true }, ENV);
    expect(forced).toEqual({ ok: true, args: ['--dry'], live: false });
  });

  it('no-dry-run tasks can only run live', () => {
    const t = getTask('sync-now')!;
    const dry = planRun(t, { apply: false }, ENV);
    expect(dry.ok).toBe(false);
    const live = planRun(t, { apply: true }, ENV);
    expect(live).toEqual({ ok: true, args: [], live: true });
  });

  it('missing env fails fast', () => {
    const t = getTask('rotate-master-key')!;
    const res = planRun(t, { apply: true }, { MANTLE_MASTER_KEY: 'k' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('MANTLE_MASTER_KEY_NEXT');
  });

  it('positional-arg tasks are CLI-only', () => {
    const t = getTask('backup-app-dbs')!;
    const res = planRun(t, { apply: true }, ENV);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('terminal');
  });
});
