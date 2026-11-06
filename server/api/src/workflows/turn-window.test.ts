/**
 * A Runners restart or fork of a turn runs with no window (docs/agent-ui.md):
 * the window rides only on the run whose workflow id is the turn's
 * stream id. No DBOS: the workflow id is handed in.
 */
import { describe, expect, it } from 'vitest';
import { withRunWindow } from './turn-window';

const TURN = 'turn-55555555-5555-4555-8555-555555555555.k1';
const options = { agentSlug: 'saskia', streamId: TURN, windowId: 'win_abcdefgh' };

describe('withRunWindow', () => {
  it("the turn's own run (first run, recovery, resume) keeps its window", () => {
    expect(withRunWindow(options, TURN)).toEqual(options);
  });

  it('a restart or fork (a new workflow id) runs with no window, all else kept', () => {
    expect(withRunWindow(options, 'f0f0f0f0-fork')).toEqual({
      agentSlug: 'saskia',
      streamId: TURN,
    });
  });

  it('no workflow id, or no stream id: no window', () => {
    expect(withRunWindow(options, undefined)).not.toHaveProperty('windowId');
    const { streamId: _s, ...noStream } = options;
    expect(withRunWindow(noStream, TURN)).not.toHaveProperty('windowId');
  });

  it('a turn with no window is left as it is', () => {
    const plain = { agentSlug: 'saskia', streamId: TURN };
    expect(withRunWindow(plain, 'other')).toBe(plain);
  });
});
