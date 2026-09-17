/**
 * The narrated-upgrade delivery regression (dev-brain task ebbacd23). The
 * narrator's status upgrade used to be published under its STEP's seq — the
 * same seq the grounded line had already emitted — and both the SSE replay
 * merger (monotonic-seq dedup) and the replay buffer (PK on `(turn_id, seq)`)
 * silently dropped it, so no client ever saw a narrated line. What must hold:
 *
 *   - the grounded line rides the step's own seq, the narrated upgrade a
 *     FRESH seq minted at publish time, both tied by the same stepId;
 *   - publishes for one turn reach the transport in mint order even though
 *     publishTurnEvent is async (the merger drops an overtaken seq);
 *   - a narration resolving after the turn's terminal event is not published
 *     (no audience; the seq cursor has been reset).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEvent } from '@mantle/client-types';

const h = vi.hoisted(() => ({
  stepObserver: null as ((e: unknown) => void) | null,
  lifecycleObserver: null as ((e: unknown) => void) | null,
  published: [] as TurnEvent[],
  // When `gate` is true, each publish parks until its releaser is called —
  // simulates a slow transport so ordering under concurrency is observable.
  gate: false,
  releasers: [] as Array<() => void>,
  narrate: (async () => null) as (label: string) => Promise<string | null>,
  nextSeq: 100,
}));

vi.mock('@mantle/tracing', () => ({
  setStepObserver: (fn: (e: unknown) => void) => {
    h.stepObserver = fn;
  },
  setTurnDeltaObserver: vi.fn(),
  setTurnLifecycleObserver: (fn: (e: unknown) => void) => {
    h.lifecycleObserver = fn;
  },
  allocateTurnSeq: () => h.nextSeq++,
}));

vi.mock('@mantle/turn-stream', () => ({
  TURN_EVENT_SCHEMA_VERSION: 1,
  publishTurnEvent: (_ownerId: string, event: TurnEvent) => {
    if (!h.gate) {
      h.published.push(event);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      h.releasers.push(() => {
        h.published.push(event);
        resolve();
      });
    });
  },
}));

vi.mock('./turn-narration', () => ({
  isTurnNarrationEnabled: () => true,
  narrateStatus: (_ownerId: string, label: string) => h.narrate(label),
}));

vi.mock('@mantle/runtime/assistant', () => ({
  stageLabelForStep: (name: string) =>
    name === 'load_context' ? null : { kind: 'brain', label: `Searching “${name}”…` },
}));

import { installTurnStreamObserver } from './turn-stream-observer';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function fireStep(turnId: string, seq: number, name = 'search_nodes'): void {
  h.stepObserver!({
    traceId: 'tr',
    ownerId: 'owner',
    turnId,
    seq,
    name,
    kind: 'tool',
    phase: 'start',
    ok: true,
    input: {},
  });
}

function fireDone(turnId: string, seq: number): void {
  h.lifecycleObserver!({ turnId, ownerId: 'owner', seq, phase: 'done', data: {} });
}

beforeEach(() => {
  h.published = [];
  h.releasers = [];
  h.gate = false;
  h.narrate = async () => null;
  h.nextSeq = 100;
  installTurnStreamObserver();
});

describe('turn-stream-observer narration', () => {
  it('publishes the narrated upgrade under a FRESH seq, tied by stepId', async () => {
    h.narrate = async () => 'Let me dig through your notes…';
    fireStep('t-fresh-seq', 5);
    await vi.waitFor(() => expect(h.published).toHaveLength(2));

    const [grounded, narrated] = h.published as [TurnEvent, TurnEvent];
    expect(grounded.type).toBe('status');
    expect(grounded.seq).toBe(5);
    expect(
      (grounded as { data: { stepId?: string; narrated?: boolean } }).data.narrated,
    ).toBeUndefined();

    expect(narrated.type).toBe('status');
    // The regression: re-using seq 5 gets dropped by the merger AND the buffer.
    expect(narrated.seq).toBe(100);
    const data = (narrated as { data: { stepId?: string; narrated?: boolean; label: string } })
      .data;
    expect(data.narrated).toBe(true);
    expect(data.stepId).toBe('5');
    expect(data.label).toBe('Let me dig through your notes…');
  });

  it('keeps a slow transport from reordering a turn’s publishes', async () => {
    h.gate = true;
    fireStep('t-order', 1);
    fireStep('t-order', 2);
    await tick();
    // Only the FIRST publish may have reached the transport — the second is
    // chained behind it, not racing it.
    expect(h.releasers).toHaveLength(1);
    h.releasers.shift()!();
    await vi.waitFor(() => expect(h.releasers).toHaveLength(1));
    h.releasers.shift()!();
    await vi.waitFor(() => expect(h.published).toHaveLength(2));
    expect(h.published.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('drops a narration that resolves after the turn finished', async () => {
    let resolveNarration!: (v: string | null) => void;
    h.narrate = () => new Promise((r) => (resolveNarration = r));
    fireStep('t-late', 1);
    fireDone('t-late', 2);
    await vi.waitFor(() => expect(h.published).toHaveLength(2)); // grounded + done
    await tick(); // let the chain's cleanup finally run
    resolveNarration('Too late…');
    await tick();
    await tick();
    expect(h.published).toHaveLength(2);
    expect(h.published.some((e) => (e as { data: { narrated?: boolean } }).data?.narrated)).toBe(
      false,
    );
  });
});
