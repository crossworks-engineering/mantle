// The extract queue's provider circuit: every transition with fakes (no
// database, no queue, no clock). The case it exists for: an embedding account
// with no credits (2026-10-04). Jobs must stop burning retries, the admin must
// be told, and recovery must need no restart.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_RECOVERY_GAP_MS,
  AUTO_RECOVERY_GAP_MS,
  ProviderCircuit,
  probeDelayMs,
  type CircuitDeps,
  type OpenAlert,
} from './provider-circuit';

const noCredits = () =>
  Object.assign(
    new Error(
      'OpenAI embeddings failed: 429 Too Many Requests — {"error":{"code":"insufficient_quota"}}',
    ),
    { providerSubject: 'embedding' },
  );
const rateLimited = () =>
  Object.assign(new Error('OpenAI embeddings failed: 429 Too Many Requests — slow down'), {
    providerSubject: 'embedding',
  });
const MIN = 60_000;

function harness() {
  let now = Date.parse('2026-10-04T08:00:00Z');
  const alerts = new Map<string, OpenAlert>();
  let probeResult: () => Promise<void> = async () => {
    throw noCredits();
  };
  const calls: string[] = [];
  const deps: CircuitDeps = {
    now: () => now,
    probe: vi.fn(async (subject) => {
      calls.push(`probe:${subject}`);
      return probeResult();
    }),
    pauseWorkers: vi.fn(async () => {
      calls.push('pause');
    }),
    resumeWorkers: vi.fn(async () => {
      calls.push('resume');
    }),
    recover: vi.fn(async () => {
      calls.push('recover');
      return { redriven: 7 };
    }),
    deadLetterCount: vi.fn(async () => 3),
    store: {
      listOpen: async () => [...alerts.values()].map((a) => ({ ...a })),
      recordFailure: vi.fn(async (subject) => {
        if (!alerts.has(subject)) {
          alerts.set(subject, {
            subject,
            paused: false,
            visible: true,
            nextProbeAt: null,
            probeAttempts: 0,
          });
        }
      }),
      setPaused: vi.fn(async (subject, paused, nextProbeAt) => {
        const a = alerts.get(subject);
        if (a) Object.assign(a, { paused, nextProbeAt, ...(paused ? { visible: true } : {}) });
      }),
      probeFailed: vi.fn(async (subject, nextProbeAt) => {
        const a = alerts.get(subject);
        if (a) Object.assign(a, { nextProbeAt, probeAttempts: a.probeAttempts + 1 });
      }),
      resolve: vi.fn(async (subject) => alerts.delete(subject)),
    },
    log: () => {},
  };
  return {
    deps,
    alerts,
    calls,
    circuit: new ProviderCircuit(deps),
    advance: (ms: number) => {
      now += ms;
    },
    probeWorks: () => {
      probeResult = async () => {};
    },
    probeFails: () => {
      probeResult = async () => {
        throw noCredits();
      };
    },
  };
}

describe('probeDelayMs', () => {
  it('backs off 5, 10, 20, 40 min, then holds at 1 h', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => probeDelayMs(n) / MIN)).toEqual([
      5, 10, 20, 40, 60, 60, 60,
    ]);
  });
});

describe('ProviderCircuit: opening', () => {
  let t: ReturnType<typeof harness>;
  beforeEach(() => {
    t = harness();
  });

  it('a confirmed account error pauses the queue and opens a shown, paused alert', async () => {
    await t.circuit.onJobError(noCredits());
    expect(t.calls).toEqual(['probe:embedding', 'pause']);
    expect(t.circuit.isPaused()).toBe(true);
    const a = t.alerts.get('embedding')!;
    expect(a).toMatchObject({ paused: true, visible: true });
    expect(a.nextProbeAt!.getTime() - t.deps.now()).toBe(5 * MIN);
  });

  it('a transient error never pauses (the queue retries it)', async () => {
    await t.circuit.onJobError(rateLimited());
    await t.circuit.onJobError(new TypeError('fetch failed'));
    expect(t.deps.probe).not.toHaveBeenCalled();
    expect(t.circuit.isPaused()).toBe(false);
  });

  it('a bad input never pauses', async () => {
    await t.circuit.onJobError(new Error('OpenAI embeddings failed: 400 Bad Request — too long'));
    expect(t.deps.probe).not.toHaveBeenCalled();
  });

  it('no pause when the confirm probe works: it was this one document', async () => {
    t.probeWorks();
    await t.circuit.onJobError(noCredits());
    expect(t.calls).toEqual(['probe:embedding']);
    expect(t.circuit.isPaused()).toBe(false);
  });

  it('a stream of failing jobs costs one confirm probe a minute, not one each', async () => {
    t.probeWorks();
    for (let i = 0; i < 20; i++) await t.circuit.onJobError(noCredits());
    expect(t.deps.probe).toHaveBeenCalledTimes(1);
    t.advance(MIN);
    await t.circuit.onJobError(noCredits());
    expect(t.deps.probe).toHaveBeenCalledTimes(2);
  });

  it('an embed failure the extractor re-threw (with `cause`) still counts as embedding', async () => {
    // Found on a throwaway brain (2026-10-04): index-writes.ts wraps the embed
    // error in its own Error; the tag on the cause must still decide.
    const wrapped = new Error('extractor: embed failed for node n1 — retrying: x', {
      cause: noCredits(),
    });
    await t.circuit.onJobError(wrapped);
    expect(t.calls).toEqual(['probe:embedding', 'pause']);
  });

  it('an untagged account error counts as the extraction model', async () => {
    const err = Object.assign(new Error('openrouter chat 402: Insufficient credits'), {
      status: 402,
    });
    await t.circuit.onJobError(err);
    expect(t.calls).toEqual(['probe:extraction', 'pause']);
  });
});

describe('ProviderCircuit: probing while it fails', () => {
  it('probes only when due, with growing gaps, and stays paused', async () => {
    const t = harness();
    await t.circuit.onJobError(noCredits());
    (t.deps.probe as ReturnType<typeof vi.fn>).mockClear();

    await t.circuit.tick(); // not due yet
    expect(t.deps.probe).not.toHaveBeenCalled();

    t.advance(5 * MIN);
    await t.circuit.tick(); // due: fails, next in 10
    expect(t.deps.probe).toHaveBeenCalledTimes(1);
    const a = t.alerts.get('embedding')!;
    expect(a.probeAttempts).toBe(1);
    expect(a.nextProbeAt!.getTime() - t.deps.now()).toBe(10 * MIN);

    t.advance(9 * MIN);
    await t.circuit.tick();
    expect(t.deps.probe).toHaveBeenCalledTimes(1);
    t.advance(MIN);
    await t.circuit.tick();
    expect(t.deps.probe).toHaveBeenCalledTimes(2);
    expect(t.circuit.isPaused()).toBe(true);
    expect(t.deps.recover).not.toHaveBeenCalled();
  });

  it('worst case over a day: 26 probes (4 in the first 75 min, then one an hour)', async () => {
    const t = harness();
    await t.circuit.onJobError(noCredits());
    (t.deps.probe as ReturnType<typeof vi.fn>).mockClear();
    for (let s = 0; s < (24 * 60 * MIN) / 30_000; s++) {
      t.advance(30_000);
      await t.circuit.tick();
    }
    const n = (t.deps.probe as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(n).toBe(26);
  });
});

describe('ProviderCircuit: recovery without a restart', () => {
  it('a probe that works closes the alert, resumes, re-drives and sweeps', async () => {
    const t = harness();
    await t.circuit.onJobError(noCredits());
    t.calls.length = 0;
    t.probeWorks();
    t.advance(5 * MIN);
    await t.circuit.tick();
    expect(t.calls).toEqual(['probe:embedding', 'resume', 'recover']);
    expect(t.alerts.has('embedding')).toBe(false);
    expect(t.circuit.isPaused()).toBe(false);
  });

  it('a config save probes at once instead of waiting for the schedule', async () => {
    const t = harness();
    await t.circuit.onJobError(noCredits());
    t.calls.length = 0;
    t.probeWorks(); // the admin switched to a working provider
    t.advance(30_000);
    t.circuit.requestRecovery('config');
    await t.circuit.tick();
    expect(t.calls).toEqual(['probe:embedding', 'resume', 'recover']);
  });

  it('a config save with no open alert recovers a waiting backlog after one probe', async () => {
    const t = harness();
    t.probeWorks();
    t.circuit.requestRecovery('config');
    await t.circuit.tick();
    expect(t.calls).toEqual(['probe:embedding', 'recover']);
  });

  it('a config save with nothing waiting costs nothing', async () => {
    const t = harness();
    (t.deps.deadLetterCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    t.circuit.requestRecovery('config');
    await t.circuit.tick();
    expect(t.calls).toEqual([]);
  });

  it('a config save whose probe still fails re-drives nothing', async () => {
    const t = harness();
    t.circuit.requestRecovery('admin');
    await t.circuit.tick();
    expect(t.calls).toEqual(['probe:embedding']);
  });

  it('an alert closed elsewhere (an embed that worked) resumes and recovers once', async () => {
    const t = harness();
    await t.circuit.onJobError(noCredits());
    await t.circuit.tick(); // learns the open subject
    t.calls.length = 0;
    t.alerts.delete('embedding'); // a search embed in the web process worked
    await t.circuit.tick();
    expect(t.calls).toEqual(['resume', 'recover']);
    await t.circuit.tick();
    expect(t.calls).toEqual(['resume', 'recover']);
  });

  it('automatic recoveries are at most one per 30 min; admin ones one per 2 min', async () => {
    const t = harness();
    t.probeWorks();
    t.circuit.requestRecovery('admin');
    await t.circuit.tick();
    t.advance(ADMIN_RECOVERY_GAP_MS - 1);
    t.circuit.requestRecovery('admin');
    await t.circuit.tick();
    expect(t.deps.recover).toHaveBeenCalledTimes(1);
    t.advance(1);
    t.circuit.requestRecovery('admin');
    await t.circuit.tick();
    expect(t.deps.recover).toHaveBeenCalledTimes(2);

    // An automatic one right after: skipped, it waits for the 30 min gap.
    t.probeFails();
    await t.circuit.onJobError(noCredits());
    t.probeWorks();
    t.advance(5 * MIN);
    await t.circuit.tick();
    expect(t.deps.recover).toHaveBeenCalledTimes(2);
    expect(AUTO_RECOVERY_GAP_MS).toBe(30 * MIN);
  });

  it('after a restart an open, paused alert holds the queue again and probes at once', async () => {
    const t = harness();
    t.alerts.set('embedding', {
      subject: 'embedding',
      paused: true,
      visible: true,
      nextProbeAt: new Date(t.deps.now() + 50 * MIN),
      probeAttempts: 3,
    });
    await t.circuit.tick();
    expect(t.calls).toEqual(['pause', 'probe:embedding']);
    expect(t.circuit.isPaused()).toBe(true);
  });

  it('a long transient outage that shows gets probes too, and recovers', async () => {
    const t = harness();
    t.alerts.set('embedding', {
      subject: 'embedding',
      paused: false,
      visible: true,
      nextProbeAt: null,
      probeAttempts: 0,
    });
    await t.circuit.tick(); // schedules the first probe
    expect(t.deps.probe).not.toHaveBeenCalled();
    t.probeWorks();
    t.advance(5 * MIN);
    await t.circuit.tick();
    expect(t.calls).toEqual(['probe:embedding', 'resume', 'recover']);
  });

  it('a short blip that does not show yet is left to the retries', async () => {
    const t = harness();
    t.alerts.set('embedding', {
      subject: 'embedding',
      paused: false,
      visible: false,
      nextProbeAt: null,
      probeAttempts: 0,
    });
    t.advance(60 * MIN);
    await t.circuit.tick();
    expect(t.calls).toEqual([]);
  });
});
