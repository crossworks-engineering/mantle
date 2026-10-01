import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevealGate } from './app-reveal';

const opts = { quietMs: 150, maxMs: 8_000 };

describe('RevealGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reveals a quiet app one quiet window after mount', () => {
    const onReveal = vi.fn();
    const g = new RevealGate(onReveal, opts);
    g.mount();
    vi.advanceTimersByTime(149);
    expect(onReveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('waits for in-flight bridge requests, including a chained one', () => {
    const onReveal = vi.fn();
    const g = new RevealGate(onReveal, opts);
    g.requestStart(); // the app's mount effect fired before ready arrived
    g.mount();
    vi.advanceTimersByTime(1_000);
    expect(onReveal).not.toHaveBeenCalled();
    g.requestEnd();
    vi.advanceTimersByTime(50);
    g.requestStart(); // the next await in the chain
    vi.advanceTimersByTime(500);
    expect(onReveal).not.toHaveBeenCalled();
    g.requestEnd();
    vi.advanceTimersByTime(150);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('holds until the app releases, then reveals at once', () => {
    const onReveal = vi.fn();
    const g = new RevealGate(onReveal, opts);
    g.hold();
    g.mount();
    vi.advanceTimersByTime(3_000);
    expect(onReveal).not.toHaveBeenCalled();
    g.release();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('a release that beats the ready signal reveals on mount', () => {
    const onReveal = vi.fn();
    const g = new RevealGate(onReveal, opts);
    g.hold();
    g.release();
    expect(onReveal).not.toHaveBeenCalled();
    g.mount();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('never keeps the loader up past the cap', () => {
    const onReveal = vi.fn();
    const g = new RevealGate(onReveal, opts);
    g.hold();
    g.requestStart();
    g.mount();
    vi.advanceTimersByTime(8_000);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('reveals once, and not at all after dispose', () => {
    const onReveal = vi.fn();
    const g = new RevealGate(onReveal, opts);
    g.mount();
    vi.advanceTimersByTime(150);
    g.release();
    vi.advanceTimersByTime(10_000);
    expect(onReveal).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    const g2 = new RevealGate(late, opts);
    g2.mount();
    g2.dispose();
    vi.advanceTimersByTime(10_000);
    expect(late).not.toHaveBeenCalled();
  });
});
