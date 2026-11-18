import { describe, expect, it } from 'vitest';

import { sandboxLimitRefusal } from './limit';

const of = (...states: string[]) => states.map((State) => ({ State }));

describe('sandboxLimitRefusal counts running sandboxes only', () => {
  it('lets a new sandbox start beside any number of stopped ones', () => {
    expect(sandboxLimitRefusal(of('exited', 'exited', 'exited', 'created'), 3)).toBeNull();
    expect(sandboxLimitRefusal(of('running', 'running', 'exited', 'exited'), 3)).toBeNull();
  });

  it('refuses at the cap of running sandboxes, and names it', () => {
    const why = sandboxLimitRefusal(of('running', 'running', 'running', 'exited'), 3);
    expect(why).toContain('3 running');
    expect(why).toContain('sandbox_stop');
  });
});
