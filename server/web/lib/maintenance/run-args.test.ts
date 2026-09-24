import { describe, expect, it } from 'vitest';
import { getTask } from './registry';
import { planRun, runEnv } from './run-args';

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

  it('a dry run of an agent task needs the agent, and a spend confirm', () => {
    for (const slug of ['persona-notes-to-journal', 'journal-rules-reconcile']) {
      const t = getTask(slug)!;
      const noAgent = planRun(t, { apply: false, confirmSpend: true }, ENV);
      expect(noAgent.ok).toBe(false);
      if (!noAgent.ok) expect(noAgent.error).toMatch(/needs agent/);
      const noConfirm = planRun(t, { apply: false, args: { agent: 'assistant' } }, ENV);
      expect(noConfirm.ok).toBe(false);
      if (!noConfirm.ok) expect(noConfirm).toMatchObject({ status: 403 });
      const ok = planRun(
        t,
        { apply: false, confirmSpend: true, args: { agent: 'assistant' } },
        ENV,
      );
      expect(ok).toEqual({ ok: true, args: ['--agent=assistant'], live: false });
    }
  });

  it('an apply needs the review page id, and only passes the args it needs', () => {
    const t = getTask('journal-rules-reconcile')!;
    const page = '0a3a19e3-eb87-49ab-aa7b-e90ceff5958f';
    const res = planRun(t, { apply: true, args: { page, agent: 'assistant' } }, ENV);
    expect(res).toEqual({ ok: true, args: ['--apply', `--page=${page}`], live: true });
    const noPage = planRun(t, { apply: true, args: { agent: 'assistant' } }, ENV);
    expect(noPage.ok).toBe(false);
  });

  it('arg values become argv, so a bad shape is refused', () => {
    const t = getTask('journal-rules-reconcile')!;
    for (const agent of ['Assistant', 'a b', '--apply', 'x;rm -rf /', '../x']) {
      const res = planRun(t, { apply: false, confirmSpend: true, args: { agent } }, ENV);
      expect(res.ok).toBe(false);
    }
    const res = planRun(t, { apply: true, args: { page: 'not-a-uuid' } }, ENV);
    expect(res.ok).toBe(false);
  });

  it('runEnv fills an empty ALLOWED_USER_ID from the owner; a set value wins', () => {
    expect(runEnv({ ALLOWED_USER_ID: '' }, 'owner-1').ALLOWED_USER_ID).toBe('owner-1');
    expect(runEnv({}, 'owner-1').ALLOWED_USER_ID).toBe('owner-1');
    expect(runEnv({ ALLOWED_USER_ID: 'set' }, 'owner-1').ALLOWED_USER_ID).toBe('set');
  });
});
