/**
 * Observability: a tool that returns `{ ok: false }` WITHOUT throwing must be
 * recorded as a FAILED step — not a 'success' with empty output. This was the
 * gap behind the confusing Grok trace: page_share errored "page not found" 7×
 * but every step showed as success. `handle.setError(msg)` now flips the step's
 * status to 'error' and writes the message to the `error` column.
 *
 * We mock @mantle/db to capture what the step UPDATE persists (status + error),
 * since the real status is computed in store.ts and written on step close.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tracesTable: { __t: 'traces' },
  traceStepsTable: { __t: 'traceSteps' },
  stepUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', () => ({
  traces: h.tracesTable,
  traceSteps: h.traceStepsTable,
  db: {
    insert: () => ({ values: async () => {} }),
    update: (tbl: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        if (tbl === h.traceStepsTable) h.stepUpdates.push(payload);
        return { where: () => ({ catch: () => {} }) };
      },
    }),
  },
}));

import { startTrace, step, setStepObserver, setTurnDeltaObserver, emitTurnDelta } from './store';

afterEach(() => {
  h.stepUpdates.length = 0;
  setStepObserver(null);
  setTurnDeltaObserver(null);
});

describe('step() observability — setError', () => {
  it('marks a soft-failed step (ok:false, no throw) as status=error with the message', async () => {
    await startTrace({ ownerId: 'o', kind: 'responder_turn' }, async () => {
      await step({ name: 'tool: page_share', kind: 'compute', input: {} }, async (handle) => {
        // Mirrors a tool returning { ok: false, error } — the dispatch path now
        // calls handle.setError on it.
        handle.setError('page page_create not found');
        return { ok: false as const };
      });
    });
    const failed = h.stepUpdates.find((u) => u.error === 'page page_create not found');
    expect(failed, 'the failed step should have been persisted').toBeTruthy();
    expect(failed!.status).toBe('error');
  });

  it('leaves a normal step as status=success with no error', async () => {
    await startTrace({ ownerId: 'o', kind: 'responder_turn' }, async () => {
      await step({ name: 'tool: page_get', kind: 'compute', input: {} }, async () => ({
        ok: true as const,
      }));
    });
    const ok = h.stepUpdates.find((u) => u.status === 'success');
    expect(ok, 'the successful step should have been persisted').toBeTruthy();
    expect(ok!.error ?? null).toBeNull();
  });

  it('setSkipped still wins (status=skipped, not error)', async () => {
    await startTrace({ ownerId: 'o', kind: 'responder_turn' }, async () => {
      await step({ name: 'tool: dup', kind: 'compute', input: {} }, async (handle) => {
        handle.setSkipped('duplicate_in_response');
        return { ok: false as const };
      });
    });
    const skipped = h.stepUpdates.find((u) => u.status === 'skipped');
    expect(skipped, 'the skipped step should have been persisted').toBeTruthy();
  });
});

describe('live turn streaming — delegated child traces', () => {
  it('child inherits the turnId + shares one seq cursor; only the root streams reply text', async () => {
    const stepEvents: Array<{ turnId: string; seq: number; phase: string; name: string }> = [];
    const deltaEvents: Array<{ seq: number; text: string }> = [];
    setStepObserver((e) =>
      stepEvents.push({ turnId: e.turnId, seq: e.seq, phase: e.phase, name: e.name }),
    );
    setTurnDeltaObserver((e) => deltaEvents.push({ seq: e.seq, text: e.text }));

    await startTrace({ ownerId: 'o', kind: 'responder_turn', turnId: 'turn-1' }, async () => {
      emitTurnDelta(0, 'text', 'root-a '); // root → streamed
      await step({ name: 'invoke_agent', kind: 'compute', input: {} }, async () => {
        // A delegated agent opens its OWN trace WITHOUT a turnId (as invokeAgent
        // does, for cost isolation) — it must INHERIT the turn's id so its steps
        // surface in the same live stream.
        await startTrace({ ownerId: 'o', kind: 'manual', subjectKind: 'child_agent' }, async () => {
          await step({ name: 'page_create', kind: 'compute', input: {} }, async () => {
            emitTurnDelta(0, 'text', 'CHILD '); // child reply text → must be suppressed
            return { ok: true as const };
          });
          return 'child-done';
        });
        return { ok: true as const };
      });
      emitTurnDelta(1, 'text', 'root-b'); // root again → streamed
      return 'done';
    });

    // Every step event — parent AND the delegated child — carries the turn id.
    expect(stepEvents.length).toBeGreaterThan(0);
    expect(stepEvents.every((e) => e.turnId === 'turn-1')).toBe(true);
    // The child's own step surfaced in the same stream (the fix).
    expect(stepEvents.some((e) => e.name === 'page_create' && e.phase === 'start')).toBe(true);
    // One monotonic seq cursor across status + token events — no collisions.
    const seqs = [...stepEvents.map((e) => e.seq), ...deltaEvents.map((d) => d.seq)];
    expect(new Set(seqs).size).toBe(seqs.length);
    // Only the ROOT turn streamed reply text — the child's tokens are suppressed
    // so a sub-agent's output never pollutes the visible reply.
    expect(deltaEvents.map((d) => d.text)).toEqual(['root-a ', 'root-b']);
  });
});
