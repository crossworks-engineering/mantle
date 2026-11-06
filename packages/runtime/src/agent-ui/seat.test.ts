/**
 * One window-driving turn per login (docs/agent-ui.md): the seat, its
 * release at the turn's end, and the window a turn may drive. No database.
 */
import { describe, expect, it, vi } from 'vitest';
import { UiWindowSeats } from './seat';
import { seatedUiWindow } from './offer';
import { endTurnUiCalls } from './end';

const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

describe('UiWindowSeats', () => {
  it('one turn per login: another waits for the release; the same turn takes it again', () => {
    const s = new UiWindowSeats();
    expect(s.take(A, 't1')).toBe(true);
    expect(s.take(A, 't1')).toBe(true);
    expect(s.take(A, 't2')).toBe(false);
    expect(s.take(A.toUpperCase(), 't2')).toBe(false);
    expect(s.take(B, 't3')).toBe(true);
    s.release(A, 't2'); // not its seat: nothing
    expect(s.take(A, 't2')).toBe(false);
    s.release(A, 't1');
    expect(s.take(A, 't2')).toBe(true);
  });

  it('a seat no turn touched for an hour is free', () => {
    let t = 0;
    const s = new UiWindowSeats(() => t);
    expect(s.take(A, 't1')).toBe(true);
    t += 61 * 60_000;
    expect(s.take(A, 't2')).toBe(true);
  });
});

describe('seatedUiWindow', () => {
  it('the decided window while the seat is free, none while another turn holds it', () => {
    const s = new UiWindowSeats();
    expect(seatedUiWindow('win_a', { loginId: A, streamId: 't1' }, s)).toBe('win_a');
    expect(seatedUiWindow('win_b', { loginId: A, streamId: 't2' }, s)).toBeNull();
    expect(seatedUiWindow(null, { loginId: B, streamId: 't3' }, s)).toBeNull();
    expect(seatedUiWindow('win_c', { loginId: null, streamId: 't3' }, s)).toBeNull();
  });
});

describe("a turn's end gives the seat back", () => {
  it('releases the turn it names, and clears its calls', async () => {
    const s = new UiWindowSeats();
    s.take(A, 't1');
    const clear = vi.fn(async () => 0);
    await endTurnUiCalls({ windowId: 'win_a', streamId: 't1', loginId: A }, { clear, seats: s });
    expect(s.take(A, 't2')).toBe(true);
    expect(clear).toHaveBeenCalledWith({ turnId: 't1', loginId: A });
  });
});
