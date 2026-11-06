/**
 * The agent UI channel's runtime half (docs/agent-ui.md): which turn is
 * offered the ui tools, the wait for the window's answer, and one call end
 * to end with its collaborators stood in (no database, no stream).
 */
import { describe, expect, it, vi } from 'vitest';
import type { UiCallRow } from '@mantle/db';
import { AGENT_UI_CALL_TTL_MS, isAgentUiWindowId } from '@mantle/client-types/agent-ui';
import type { ToolHandlerContext } from '@mantle/tools';
import { agentUiWindowFor } from './offer';
import { AGENT_UI_TOOL_SLUGS } from './slugs';
import { AGENT_UI_TOOLS, runUiCall, traceInput, type UiCallDeps } from './tools';
import { UI_POLL_MS, pauseForUiCall, wakeUiCall, waitForUiAnswer, type UiWaitDeps } from './wait';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const WINDOW = 'win_abcdefgh';
const TURN = 'turn-1';
const CALL = '33333333-3333-4333-8333-333333333333';

describe('the window id', () => {
  it('takes 8 to 64 of [A-Za-z0-9_-] and nothing else', () => {
    expect(isAgentUiWindowId('abcdefgh')).toBe(true);
    expect(isAgentUiWindowId('A-b_9'.repeat(12).slice(0, 64))).toBe(true);
    expect(isAgentUiWindowId('abcdefg')).toBe(false); // 7
    expect(isAgentUiWindowId('a'.repeat(65))).toBe(false);
    expect(isAgentUiWindowId('abcd efgh')).toBe(false);
    expect(isAgentUiWindowId('abcd/efgh')).toBe(false);
    expect(isAgentUiWindowId('abcdefgh\n')).toBe(false);
    expect(isAgentUiWindowId(12345678)).toBe(false);
    expect(isAgentUiWindowId(undefined)).toBe(false);
  });
});

describe('agentUiWindowFor: the ui tools only with a window and the setting on', () => {
  const on = { windowId: WINDOW, streamId: TURN, loginId: LOGIN, enabled: true };
  it('offers them with all four', () => {
    expect(agentUiWindowFor(on)).toBe(WINDOW);
  });
  it('not with the setting off', () => {
    expect(agentUiWindowFor({ ...on, enabled: false })).toBeUndefined();
  });
  it('not without a window, or with a bad one', () => {
    expect(agentUiWindowFor({ ...on, windowId: undefined })).toBeUndefined();
    expect(agentUiWindowFor({ ...on, windowId: 'short' })).toBeUndefined();
  });
  it('not on a turn that does not stream, or serves no login', () => {
    expect(agentUiWindowFor({ ...on, streamId: undefined })).toBeUndefined();
    expect(agentUiWindowFor({ ...on, loginId: null })).toBeUndefined();
  });
});

describe('the tool definitions', () => {
  it('are the seven slugs, writes, never in a recipe, a run item or a team app', () => {
    expect(AGENT_UI_TOOLS.map((d) => d.slug)).toEqual([...AGENT_UI_TOOL_SLUGS]);
    for (const d of AGENT_UI_TOOLS) {
      expect(d.policy.effect, d.slug).toBe('write');
      expect(d.policy.recipe, d.slug).toEqual({ step: 'forbidden', runItem: 'banned' });
      expect(d.policy.memberApp, d.slug).toBe('refused');
      expect(d.mcpOnly, d.slug).toBeUndefined();
    }
    expect(AGENT_UI_TOOLS.find((d) => d.slug === 'ui_type')?.redactInputFields).toEqual(['text']);
  });

  it('the trace keeps at most 40 characters of typed text, never the screen', () => {
    const long = 'x'.repeat(100);
    const t = traceInput('type', { target: { ref: 'e12' }, text: long, replace: true });
    expect(t).toEqual({ action: 'type', target: 'ref e12', text: 'x'.repeat(40), replace: true });
    expect(
      traceInput('point', { target: { role: 'button', name: 'Save' }, caption: long }),
    ).toEqual({
      action: 'point',
      target: 'button "Save"',
      caption: 'x'.repeat(40),
    });
    expect(traceInput('screen', {})).toEqual({ action: 'screen' });
  });
});

/** A wait whose clock moves only when it pauses. */
function fakeWait(rows: Array<Pick<UiCallRow, 'status' | 'result'> | null>) {
  let t = 0;
  let i = 0;
  const pauses: number[] = [];
  const deps: UiWaitDeps = {
    read: async () => rows[Math.min(i++, rows.length - 1)] ?? null,
    now: () => t,
    pause: async (_id, ms) => {
      pauses.push(ms);
      t += ms;
    },
  };
  return { deps, pauses, now: () => t };
}

describe('waitForUiAnswer', () => {
  const pending = { status: 'pending' as const, result: null };

  it('answers the window result once the row is done', async () => {
    const w = fakeWait([pending, pending, { status: 'done', result: { ok: true, x: 1 } }]);
    expect(await waitForUiAnswer(CALL, 10_000, w.deps)).toEqual({
      kind: 'done',
      result: { ok: true, x: 1 },
    });
    expect(w.pauses).toEqual([UI_POLL_MS, UI_POLL_MS]);
  });

  it('times out to window_gone at expires_at, polling every 200 ms', async () => {
    const w = fakeWait([pending]);
    expect(await waitForUiAnswer(CALL, AGENT_UI_CALL_TTL_MS, w.deps)).toEqual({
      kind: 'window_gone',
    });
    expect(w.now()).toBe(AGENT_UI_CALL_TTL_MS);
    expect(w.pauses.length).toBe(AGENT_UI_CALL_TTL_MS / UI_POLL_MS);
    expect(Math.max(...w.pauses)).toBe(UI_POLL_MS);
  });

  it('the last pause stops at the deadline, never past it', async () => {
    const w = fakeWait([pending]);
    await waitForUiAnswer(CALL, 450, w.deps);
    expect(w.pauses).toEqual([200, 200, 50]);
  });

  it('a row given up by Stop, or an aborted turn, is stopped', async () => {
    expect(
      await waitForUiAnswer(CALL, 10_000, fakeWait([{ status: 'expired', result: null }]).deps),
    ).toEqual({ kind: 'stopped' });
    const ac = new AbortController();
    ac.abort();
    expect(await waitForUiAnswer(CALL, 10_000, fakeWait([pending]).deps, ac.signal)).toEqual({
      kind: 'stopped',
    });
  });

  it('a row that is gone is window_gone', async () => {
    expect(await waitForUiAnswer(CALL, 10_000, fakeWait([null]).deps)).toEqual({
      kind: 'window_gone',
    });
  });

  it('answers with no LISTEN at all: the default pause, the real clock, only the poll', async () => {
    // A process with no ui_result listener (wakeUiCall never called): the
    // wait still answers by reading the row every UI_POLL_MS.
    let reads = 0;
    const deps: UiWaitDeps = {
      read: async () =>
        ++reads < 3 ? pending : { status: 'done' as const, result: { ok: true, polled: true } },
      now: () => Date.now(),
      pause: pauseForUiCall,
    };
    const started = Date.now();
    expect(await waitForUiAnswer(CALL, Date.now() + 5_000, deps)).toEqual({
      kind: 'done',
      result: { ok: true, polled: true },
    });
    expect(reads).toBe(3);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(2 * UI_POLL_MS - 20);
    expect(took).toBeLessThan(2_000);
  });

  it('a wake ends the pause at once', async () => {
    const started = Date.now();
    const p = pauseForUiCall(CALL, 5_000);
    wakeUiCall(CALL);
    await p;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

const ctx = (surface: ToolHandlerContext['surface'], toolCallId = 'call_1'): ToolHandlerContext =>
  ({ ownerId: 'owner-1', surface, toolCallId }) as ToolHandlerContext;
const WEB = { kind: 'web' as const, loginId: LOGIN, uiWindowId: WINDOW };

/** A call's collaborators: a ui_calls table of one step key at most. */
function fakeCall(answer: Pick<UiCallRow, 'status' | 'result'> | null) {
  const rows = new Map<string, UiCallRow>();
  const emitted: unknown[] = [];
  const deps: UiCallDeps = {
    open: vi.fn(async (c) => {
      const had = rows.get(c.stepKey);
      if (had) return { row: had, created: false };
      const row = {
        id: CALL,
        turnId: c.turnId,
        loginId: c.loginId,
        windowId: c.windowId,
        stepKey: c.stepKey,
        action: c.action,
        args: c.args,
        status: 'pending',
        result: null,
        createdAt: new Date(0),
        expiresAt: new Date(Date.now() + 1_000),
        answeredAt: null,
      } as UiCallRow;
      rows.set(c.stepKey, row);
      return { row, created: true };
    }),
    emit: vi.fn((_turn, _owner, data) => {
      emitted.push(data);
      return true;
    }),
    wait: {
      read: async () => answer,
      now: () => Date.now(),
      pause: async () => {},
    },
    turnId: () => TURN,
    signal: () => undefined,
  };
  return { deps, rows, emitted };
}

describe('runUiCall', () => {
  it('opens one row keyed on the turn and the tool call, asks the window, returns its result', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true, route: '/pages' } });
    const res = await runUiCall('navigate', { path: '/pages' }, ctx(WEB), f.deps);
    expect(res).toEqual({ ok: true, output: { ok: true, route: '/pages' } });
    expect([...f.rows.keys()]).toEqual([`${TURN}:call_1`]);
    expect(f.emitted).toEqual([
      { callId: CALL, action: 'navigate', args: { path: '/pages' }, expiresAt: expect.any(String) },
    ]);
  });

  it('a re-run of the same step (step_key) reuses the row and does not ask the window twice', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true } });
    await runUiCall('click', { target: { ref: 'e1' } }, ctx(WEB), f.deps);
    await runUiCall('click', { target: { ref: 'e1' } }, ctx(WEB), f.deps);
    expect(f.rows.size).toBe(1);
    expect(f.emitted.length).toBe(1);
    // Another tool call of the turn is another row.
    await runUiCall('click', { target: { ref: 'e1' } }, ctx(WEB, 'call_2'), f.deps);
    expect(f.rows.size).toBe(2);
  });

  it("passes the window's refusal on as a tool failure, code first", async () => {
    const f = fakeCall({
      status: 'done',
      result: { ok: false, error: 'needs_user', message: 'the person must press Delete' },
    });
    const res = await runUiCall('click', { target: { ref: 'e9' } }, ctx(WEB), f.deps);
    expect(res).toEqual({ ok: false, error: 'needs_user: the person must press Delete' });
  });

  it('no answer by expires_at is window_gone', async () => {
    const f = fakeCall({ status: 'pending', result: null });
    let t = 0;
    f.deps.wait.now = () => t;
    f.deps.wait.pause = async (_id, ms) => {
      t += ms;
    };
    const res = await runUiCall('screen', {}, ctx(WEB), f.deps);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.startsWith('window_gone:')).toBe(true);
  });

  it("a member's workspace turn (team surface): the row is the member's, on its own turn id", async () => {
    const f = fakeCall({ status: 'done', result: { ok: true } });
    const memberTurn = `ws-${LOGIN}.k1`;
    f.deps.turnId = () => memberTurn;
    const team = { kind: 'team' as const, loginId: LOGIN, uiWindowId: WINDOW };
    const res = await runUiCall('screen', {}, ctx(team), f.deps);
    expect(res).toEqual({ ok: true, output: { ok: true } });
    expect(f.deps.open).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: memberTurn, loginId: LOGIN, windowId: WINDOW }),
    );
    expect(f.emitted).toHaveLength(1);
  });

  it('refuses a turn with no window, no login or no stream, before any row', async () => {
    for (const surface of [
      { kind: 'web' as const, loginId: LOGIN },
      { kind: 'web' as const, uiWindowId: WINDOW },
      { kind: 'team' as const, loginId: LOGIN },
      { kind: 'team' as const, uiWindowId: WINDOW },
      { kind: 'owner' as const, via: 'mcp' as const, uiWindowId: WINDOW } as never,
      undefined,
    ]) {
      const f = fakeCall(null);
      const res = await runUiCall('screen', {}, ctx(surface), f.deps);
      expect(!res.ok && res.error.startsWith('no_session:')).toBe(true);
      expect(f.deps.open).not.toHaveBeenCalled();
    }
    const f = fakeCall(null);
    f.deps.turnId = () => null;
    const res = await runUiCall('screen', {}, ctx(WEB), f.deps);
    expect(!res.ok && res.error.startsWith('no_session:')).toBe(true);
  });

  it('refuses a target named two ways, or none where one is needed', async () => {
    const f = fakeCall(null);
    const two = await runUiCall('click', { target: { ref: 'e1', id: 'x' } }, ctx(WEB), f.deps);
    expect(two.ok).toBe(false);
    const none = await runUiCall('click', {}, ctx(WEB), f.deps);
    expect(none.ok).toBe(false);
    const roleOnly = await runUiCall('click', { target: { role: 'button' } }, ctx(WEB), f.deps);
    expect(roleOnly.ok).toBe(false);
    expect(f.deps.open).not.toHaveBeenCalled();
  });

  it('refuses arguments too long for one stream event', async () => {
    const f = fakeCall(null);
    const res = await runUiCall(
      'type',
      { target: { ref: 'e1' }, text: 'y'.repeat(7000) },
      ctx(WEB),
      f.deps,
    );
    expect(res.ok).toBe(false);
    expect(f.deps.open).not.toHaveBeenCalled();
  });
});
