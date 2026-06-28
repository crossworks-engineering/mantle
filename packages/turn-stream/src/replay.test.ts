/**
 * The replay merger is the correctness core of `Last-Event-ID` resume: it merges
 * a replayed backlog with the live NOTIFY stream so a reconnecting client neither
 * MISSES nor DUPLICATES an event. Pure + synchronous, so we exercise the gap and
 * dedup invariants deterministically here (the DB read + SSE plumbing around it is
 * covered by the live smoke). See docs/live-turn-streaming.md §2/§7.
 */
import { describe, expect, it } from 'vitest';
import type { TurnEvent } from '@mantle/client-types';
import { makeReplayMerger } from './replay';

/** Minimal TurnEvent — the merger only reads `seq`; `type` tags it for assertions. */
function ev(seq: number, type = 'text-delta'): TurnEvent {
  return { v: 1, turnId: 't', seq, round: 0, type, data: {} } as unknown as TurnEvent;
}

const seqs = (out: TurnEvent[]): number[] => out.map((e) => e.seq);

describe('makeReplayMerger', () => {
  it('fresh connect (sinceSeq -1) emits the whole backlog from seq 0, in order', () => {
    const out: TurnEvent[] = [];
    const m = makeReplayMerger(-1, (e) => out.push(e));
    m.replay([ev(0), ev(1), ev(2)]);
    expect(seqs(out)).toEqual([0, 1, 2]);
  });

  it('resume (sinceSeq N) skips events with seq <= N', () => {
    const out: TurnEvent[] = [];
    const m = makeReplayMerger(3, (e) => out.push(e));
    // A buffer read may over-return; the guard still drops anything <= N.
    m.replay([ev(2), ev(3), ev(4), ev(5)]);
    expect(seqs(out)).toEqual([4, 5]);
  });

  it('queues live events that arrive DURING replay, then drains them after the backlog (no gap)', () => {
    const out: TurnEvent[] = [];
    const m = makeReplayMerger(-1, (e) => out.push(e));
    // Live events land in the async window between "subscribed" and "backlog read".
    m.live(ev(3));
    m.live(ev(4));
    m.replay([ev(0), ev(1), ev(2)]);
    expect(seqs(out)).toEqual([0, 1, 2, 3, 4]);
  });

  it('dedups the backlog/live overlap by seq (an event in BOTH is emitted once)', () => {
    const out: TurnEvent[] = [];
    const m = makeReplayMerger(-1, (e) => out.push(e));
    m.live(ev(2)); // also present in the backlog below
    m.live(ev(3));
    m.replay([ev(0), ev(1), ev(2)]);
    expect(seqs(out)).toEqual([0, 1, 2, 3]); // 2 not repeated
  });

  it('emits live events directly once replay has run, still deduping stale seqs', () => {
    const out: TurnEvent[] = [];
    const m = makeReplayMerger(-1, (e) => out.push(e));
    m.replay([ev(0), ev(1)]);
    m.live(ev(2));
    m.live(ev(1)); // stale (a re-delivered NOTIFY) — dropped
    m.live(ev(3));
    expect(seqs(out)).toEqual([0, 1, 2, 3]);
  });

  it('empty backlog (the normal pre-POST subscribe) just live-tails', () => {
    const out: TurnEvent[] = [];
    const m = makeReplayMerger(-1, (e) => out.push(e));
    m.replay([]);
    m.live(ev(0));
    m.live(ev(1));
    expect(seqs(out)).toEqual([0, 1]);
  });
});
