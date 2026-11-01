/**
 * Out of file descriptors, spawn does not throw at once: it hands back a
 * process with no stdin, or throws. The guard must cost the protection then,
 * never the child (a throw here left a started child out of the pool).
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));

import { killWithParent } from './kill-with-parent';

const child = () => Object.assign(new EventEmitter(), { pid: 123 }) as unknown as ChildProcess;

describe('killWithParent with no file descriptors left', () => {
  it('takes a guard with no stdin', () => {
    const guard = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() });
    spawn.mockReturnValueOnce(guard);
    expect(() => killWithParent(child())).not.toThrow();
  });

  it('takes a spawn that throws', () => {
    spawn.mockImplementationOnce(() => {
      throw new Error('spawn EMFILE');
    });
    expect(() => killWithParent(child())).not.toThrow();
  });
});
