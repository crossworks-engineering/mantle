/**
 * The would-refuse count's reading of calls when the catalog cannot be
 * read: every call the statement makes is counted as unread (never as
 * nothing refused), and the failed load is not kept.
 */
import { describe, expect, it } from 'vitest';
import { takeNarrowWrites } from './actor';
import { noteWouldRefuseCalls } from './gateway/narrow-would-refuse';

describe('the would-refuse call reading, catalog unread', () => {
  it('counts each called function as unread when the catalog load fails, and tries again next time', async () => {
    takeNarrowWrites();
    let loads = 0;
    const failing = {
      unsafe: () => {
        loads++;
        return Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }));
      },
    } as unknown as Parameters<typeof noteWouldRefuseCalls>[0];
    noteWouldRefuseCalls(failing, 'select mantle_one($1), public.mantle_two($2)');
    await new Promise((r) => setTimeout(r, 10));
    const first = takeNarrowWrites().map((w) => `${w.check} ${w.detail}`);
    expect(first.sort()).toEqual([
      'narrow-would-refuse fn:mantle_one UNREAD',
      'narrow-would-refuse fn:mantle_two UNREAD',
    ]);
    // A statement with no mantle_ call is not read at all.
    noteWouldRefuseCalls(failing, 'select 1');
    await new Promise((r) => setTimeout(r, 10));
    expect(takeNarrowWrites()).toEqual([]);
    expect(loads).toBe(1);
    // The failure was not kept: the next statement loads again.
    noteWouldRefuseCalls(failing, 'select mantle_one($1)');
    await new Promise((r) => setTimeout(r, 10));
    expect(loads).toBe(2);
    expect(takeNarrowWrites().map((w) => w.detail)).toEqual(['fn:mantle_one UNREAD']);
  });
});
