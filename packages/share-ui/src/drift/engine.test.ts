import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIME_FOLD, createDrift, foldTime } from './engine';

/**
 * The engine's lifecycle, without a GPU: a stub WebGL context that accepts
 * every call and counts the draws, and hand-driven frame and timer queues.
 * What is pinned is the scheduling, not the picture: a zero-size box never
 * spins, an empty palette never paints, a pause leaves nothing armed and a
 * resume restarts the loop.
 */

let frames = new Map<number, (now: number) => void>();
let timers = new Map<number, () => void>();
let nextId = 1;
let now = 0;
let draws = 0;
let resize: ((entries: { contentRect: { width: number; height: number } }[]) => void) | null = null;

function stubGl() {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (/^[A-Z0-9_]+$/.test(prop)) return 1;
        if (prop === 'isContextLost') return () => false;
        if (prop === 'getExtension') return () => null;
        if (prop === 'drawArrays') return () => void draws++;
        if (prop === 'checkFramebufferStatus') return () => 1;
        if (prop.startsWith('create') || prop === 'getUniformLocation') return () => ({});
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
        return () => undefined;
      },
    },
  );
}

function stubCanvas(width: number, height: number) {
  const gl = stubGl();
  return {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => gl,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement & { style: Record<string, string> };
}

/** Run every queued frame and timer, `rounds` times, 34 ms apart. */
function run(rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    now += 34;
    const t = [...timers.values()];
    timers = new Map();
    t.forEach((fn) => fn());
    const f = [...frames.values()];
    frames = new Map();
    f.forEach((fn) => fn(now));
  }
}

const armed = () => frames.size + timers.size;

beforeEach(() => {
  frames = new Map();
  timers = new Map();
  draws = 0;
  now = 1000;
  resize = null;
  const noop = () => {};
  vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => {
    const id = nextId++;
    frames.set(id, fn);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => void frames.delete(id));
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    setTimeout: (fn: () => void) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    addEventListener: noop,
    removeEventListener: noop,
  });
  vi.stubGlobal('clearTimeout', (id: number) => void timers.delete(id));
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: { addEventListener: noop, removeEventListener: noop },
    // parseColor's fallback for non-hex colours: a 2D probe that cannot read.
    createElement: () => ({ getContext: () => null }),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: typeof resize) {
        resize = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const STILL = { speed: 0, background: '#101010', colors: ['#334455', '#556677'] };

describe('the Drift engine lifecycle', () => {
  it('paints one frame and stops when still', () => {
    const drift = createDrift(stubCanvas(200, 100), STILL);
    expect(drift).not.toBeNull();
    run(3);
    expect(draws).toBeGreaterThan(0);
    expect(armed()).toBe(0);
    expect(drift!.stats().animating).toBe(false);
  });

  it('never spins on a zero-size box, and starts when the box gets a size', () => {
    createDrift(stubCanvas(0, 0), { ...STILL, speed: 1 });
    run(5);
    expect(draws).toBe(0);
    expect(armed()).toBe(0);
    resize?.([{ contentRect: { width: 300, height: 150 } }]);
    run(2);
    expect(draws).toBeGreaterThan(0);
    expect(armed()).toBeGreaterThan(0);
  });

  it('paints nothing for an empty palette or an unreadable ground', () => {
    const canvas = stubCanvas(200, 100);
    createDrift(canvas, { ...STILL, colors: [] });
    run(3);
    expect(draws).toBe(0);
    expect(canvas.style.opacity).toBe('0');

    const bad = stubCanvas(200, 100);
    createDrift(bad, { ...STILL, background: 'not-a-colour' });
    run(3);
    expect(draws).toBe(0);
  });

  it('leaves nothing armed on pause, and runs again on resume', () => {
    const drift = createDrift(stubCanvas(200, 100), { ...STILL, speed: 1 })!;
    run(4);
    expect(drift.stats().animating).toBe(true);
    drift.pause();
    expect(armed()).toBe(0);
    const before = draws;
    run(3);
    expect(draws).toBe(before);
    drift.resume();
    run(3);
    expect(draws).toBeGreaterThan(before);
    expect(drift.stats().animating).toBe(true);
    drift.destroy();
    expect(armed()).toBe(0);
  });

  it('waits for the next slot on a timer, not by spinning frames', () => {
    createDrift(stubCanvas(200, 100), { ...STILL, speed: 1, maxFps: 10 });
    run(1);
    // After a drawn frame the loop sleeps on a timer until the next 100 ms
    // slot instead of asking for every display frame.
    expect(timers.size + frames.size).toBe(1);
    expect(timers.size).toBe(1);
  });
});

describe('foldTime', () => {
  it('stays bounded and continuous across the fold', () => {
    for (const t of [0, 1, TIME_FOLD - 0.5, TIME_FOLD, TIME_FOLD + 0.5, TIME_FOLD * 7.3, 1e9]) {
      const v = foldTime(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(TIME_FOLD);
    }
    const step = 1 / 30;
    for (const edge of [TIME_FOLD, TIME_FOLD * 2, TIME_FOLD * 9]) {
      expect(Math.abs(foldTime(edge + step) - foldTime(edge - step))).toBeLessThanOrEqual(
        2 * step + 1e-6,
      );
    }
  });
});
