import { describe, expect, it } from 'vitest';
import { childThinkingArgs } from './invoke-agent';
import { heartbeatThinking } from '../heartbeats/fire';

// The delegated-agent and heartbeat halves of the precedence rule (the table
// itself is in content-core's agent-thinking.test.ts). Pure helpers: nothing
// here touches the db.

describe('childThinkingArgs (delegated agent)', () => {
  it('inherit forwards the budget alone, no effort: the shape before 0228', () => {
    expect(childThinkingArgs({ thinkingEffort: null }, 4096)).toEqual({
      thinkingBudget: 4096,
      inheritThinkingBudget: 4096,
    });
  });

  it('inherit with nothing forwarded stays off', () => {
    expect(childThinkingArgs({ thinkingEffort: null }, undefined)).toEqual({});
    expect(childThinkingArgs({}, 0)).toEqual({});
  });

  it('an own tier wins and still hands the inherited budget on', () => {
    expect(childThinkingArgs({ thinkingEffort: 'high' }, 1024)).toEqual({
      thinkingBudget: 8000,
      thinkingEffort: 'high',
      inheritThinkingBudget: 1024,
    });
    expect(childThinkingArgs({ thinkingEffort: 'low' }, undefined)).toEqual({
      thinkingBudget: 1024,
      thinkingEffort: 'low',
    });
  });

  it("own 'off' drops reasoning for this agent only", () => {
    expect(childThinkingArgs({ thinkingEffort: 'off' }, 4096)).toEqual({
      inheritThinkingBudget: 4096,
    });
  });
});

describe('heartbeatThinking', () => {
  it('inherit keeps the profile budget and sends no effort, as before', () => {
    expect(heartbeatThinking({ thinkingEffort: null }, 4096)).toEqual({ thinkingBudget: 4096 });
    expect(heartbeatThinking({ thinkingEffort: null }, 0)).toEqual({ thinkingBudget: 0 });
  });

  it('an own tier applies with its effort; own off is 0', () => {
    expect(heartbeatThinking({ thinkingEffort: 'medium' }, 0)).toEqual({
      thinkingBudget: 4096,
      thinkingEffort: 'medium',
    });
    expect(heartbeatThinking({ thinkingEffort: 'off' }, 8000)).toEqual({ thinkingBudget: 0 });
  });
});
