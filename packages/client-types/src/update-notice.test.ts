/**
 * The update notice's rule (update-notice.ts): a manual "on" counts only on
 * the version it was set on and for an hour at most; the updater counts
 * while it pulls or rolls, for an hour at most; anything malformed is off.
 */
import { describe, expect, it } from 'vitest';
import {
  UPDATE_NOTICE_MAX_MS,
  manualNoticeUntil,
  projectUpdateNotice,
  updateNoticeOn,
  updaterBusy,
} from './update-notice';

const T0 = Date.parse('2026-11-06T10:00:00.000Z');
const SET = { setAt: '2026-11-06T10:00:00.000Z', version: '0.500.31' };

describe('projectUpdateNotice', () => {
  it('keeps a well-formed value', () => {
    expect(projectUpdateNotice(SET)).toEqual(SET);
  });
  it.each([null, undefined, 'on', true, {}, { setAt: 'soon', version: '1' }, { setAt: SET.setAt }])(
    'drops %j',
    (v) => {
      expect(projectUpdateNotice(v)).toBeUndefined();
    },
  );
  it('drops extra keys', () => {
    expect(projectUpdateNotice({ ...SET, by: 'someone' })).toEqual(SET);
  });
});

describe('manualNoticeUntil', () => {
  it('counts for an hour on the same version', () => {
    expect(manualNoticeUntil(SET, '0.500.31', T0 + 1000)).toBe(T0 + UPDATE_NOTICE_MAX_MS);
  });
  it('stops at the hour', () => {
    expect(manualNoticeUntil(SET, '0.500.31', T0 + UPDATE_NOTICE_MAX_MS)).toBeNull();
  });
  it('stops on another version (the box rolled)', () => {
    expect(manualNoticeUntil(SET, '0.500.32', T0 + 1000)).toBeNull();
  });
  it('is off with nothing stored', () => {
    expect(manualNoticeUntil(undefined, '0.500.31', T0)).toBeNull();
  });
});

describe('updaterBusy', () => {
  const started = '2026-11-06T10:00:00.000Z';
  it.each(['pulling', 'rolling'])('counts %s', (phase) => {
    expect(updaterBusy({ phase, startedAt: started }, T0 + 1000)).toBe(true);
  });
  it.each(['idle', 'requested', 'done', 'error', 'unconfigured'])('not %s', (phase) => {
    expect(updaterBusy({ phase, startedAt: started }, T0 + 1000)).toBe(false);
  });
  it('not a run that started over an hour ago (an updater that died)', () => {
    expect(updaterBusy({ phase: 'rolling', startedAt: started }, T0 + UPDATE_NOTICE_MAX_MS)).toBe(
      false,
    );
  });
  it('not without a start, nor without a status', () => {
    expect(updaterBusy({ phase: 'rolling', startedAt: null }, T0)).toBe(false);
    expect(updaterBusy(null, T0)).toBe(false);
  });
});

describe('updateNoticeOn', () => {
  it('is on by hand, or while the updater runs', () => {
    expect(updateNoticeOn({ notice: SET, version: '0.500.31', updater: null, now: T0 })).toBe(true);
    expect(
      updateNoticeOn({
        notice: undefined,
        version: '0.500.31',
        updater: { phase: 'pulling', startedAt: SET.setAt },
        now: T0,
      }),
    ).toBe(true);
  });
  it('is off once the box runs the new version and the updater is done', () => {
    expect(
      updateNoticeOn({
        notice: SET,
        version: '0.500.32',
        updater: { phase: 'done', startedAt: SET.setAt },
        now: T0 + 60_000,
      }),
    ).toBe(false);
  });
});
