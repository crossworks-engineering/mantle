/**
 * The reopen target a done task carries (`data.status_before_done`), read the
 * same way by the task row and by the item tree's row metadata.
 */
import { describe, expect, it } from 'vitest';
import { statusBeforeDoneOf } from './task-status';
import { itemMeta } from './tree/kinds';

describe('statusBeforeDoneOf', () => {
  it('returns a remembered not-done status', () => {
    expect(statusBeforeDoneOf({ status_before_done: 'blocked' })).toBe('blocked');
    expect(statusBeforeDoneOf({ status_before_done: 'in_progress' })).toBe('in_progress');
    expect(statusBeforeDoneOf({ status_before_done: 'open' })).toBe('open');
  });

  it('returns null for nothing, done, or a value that is not a status', () => {
    expect(statusBeforeDoneOf({})).toBeNull();
    expect(statusBeforeDoneOf({ status_before_done: 'done' })).toBeNull();
    expect(statusBeforeDoneOf({ status_before_done: 'later' })).toBeNull();
    expect(statusBeforeDoneOf({ status_before_done: 3 })).toBeNull();
  });
});

describe('itemMeta for tasks', () => {
  it('names the reopen target on a done task only', () => {
    expect(itemMeta('tasks', { status: 'done', status_before_done: 'blocked' })).toEqual({
      done: true,
      due: null,
      reopensTo: 'blocked',
    });
    expect(itemMeta('tasks', { status: 'done' })).toEqual({ done: true, due: null });
    // A stale key on a task that is no longer done is ignored.
    expect(itemMeta('tasks', { status: 'open', status_before_done: 'blocked' })).toEqual({
      done: false,
      due: null,
    });
  });
});
