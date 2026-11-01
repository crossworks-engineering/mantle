/** withRoleRetry: which catalog races it runs again, and which it leaves. */
import { describe, expect, it, vi } from 'vitest';
import { withRoleRetry } from './viewer-roles';

/** Fails once with `text`, then answers. */
const failsOnce = (text: string) => {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls === 1) throw new Error(text);
    return 'done';
  });
};

describe('withRoleRetry', () => {
  it.each([
    'tuple concurrently updated',
    'tuple concurrently deleted',
    'deadlock detected',
    'cache lookup failed for relation 53860',
    'cache lookup failed for attribute 3 of relation 53860',
  ])('runs again after "%s"', async (text) => {
    const fn = failsOnce(text);
    await expect(withRoleRetry(fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('leaves a deadlock to a caller with a loop of its own, and no other race', async () => {
    const deadlock = failsOnce('deadlock detected');
    await expect(withRoleRetry(deadlock, { leaveDeadlocks: true })).rejects.toThrow(/deadlock/);
    expect(deadlock).toHaveBeenCalledTimes(1);
    const tuple = failsOnce('tuple concurrently updated');
    await expect(withRoleRetry(tuple, { leaveDeadlocks: true })).resolves.toBe('done');
  });

  it('raises any other error at once', async () => {
    const fn = failsOnce('permission denied for table nodes');
    await expect(withRoleRetry(fn)).rejects.toThrow(/permission denied/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
