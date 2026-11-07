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
import {
  AGENT_UI_TOOLS,
  UiStepKeys,
  runUiCall,
  traceInput,
  uiStepKey,
  windowArgs,
  type UiCallDeps,
} from './tools';
import { UI_POLL_MS, pauseForUiCall, wakeUiCall, waitForUiAnswer, type UiWaitDeps } from './wait';
import { UI_BUDGET_ERROR, UI_TEAM_MAX_CALLS, UI_TEAM_MAX_WAIT_MS, UiBudget } from './budget';
import { PRIVATE_OUTPUT_TOOL_SLUGS, policyUntrusted } from '@mantle/tools';
import { replyUsedPrivate } from '../assistant/run-team-turn';
import { endTurnUiCalls } from './end';

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
  it('are private output and untrusted: never journaled or spilled, a team reply marked, screen text fenced', () => {
    for (const d of AGENT_UI_TOOLS) {
      expect(PRIVATE_OUTPUT_TOOL_SLUGS.has(d.slug), d.slug).toBe(true);
      expect(d.policy.outside, d.slug).toEqual({ untrusted: true });
      expect(policyUntrusted(d.policy), d.slug).toBe(true);
    }
    expect([...PRIVATE_OUTPUT_TOOL_SLUGS].sort()).toEqual([...AGENT_UI_TOOL_SLUGS].sort());
    // A member's reply from a turn that used a ui tool is used_private.
    expect(replyUsedPrivate([{ slug: 'page_get' }, { slug: 'ui_screen' }], [])).toBe(true);
    expect(replyUsedPrivate([{ slug: 'page_get' }], [])).toBe(false);
  });

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

  it('their tool steps keep the slug and the outcome code only (traceCodeOnly)', () => {
    for (const d of AGENT_UI_TOOLS) expect(d.traceCodeOnly, d.slug).toBe(true);
  });

  it('the ui_action trace step holds the action only: no target, caption, option, path or text', () => {
    for (const d of AGENT_UI_TOOLS) {
      const action = d.slug.slice(3) as Parameters<typeof traceInput>[0];
      expect(traceInput(action)).toEqual({ action });
    }
  });
});

describe('ui_type appends by default (docs/agent-ui.md)', () => {
  it('its description and its replace field say so', () => {
    const type = AGENT_UI_TOOLS.find((d) => d.slug === 'ui_type')!;
    expect(type.description).toContain('added at the end');
    const props = type.inputSchema.properties as Record<string, { description: string }>;
    expect(props.replace!.description).toMatch(/^true: clear the field first/);
    expect(props.replace!.description).toContain('append');
    expect(type.inputSchema.required).toEqual(['target', 'text']);
  });

  it('the window is always told: replace only on `replace: true`', () => {
    expect(windowArgs('type', { target: { ref: 'e1' }, text: 'hi' })).toEqual({
      target: { ref: 'e1' },
      text: 'hi',
      replace: false,
    });
    expect(windowArgs('type', { text: 'hi', replace: 'yes' }).replace).toBe(false);
    expect(windowArgs('type', { text: 'hi', replace: true }).replace).toBe(true);
    expect(windowArgs('click', { target: { ref: 'e1' } })).toEqual({ target: { ref: 'e1' } });
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
        args: {},
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
    budget: new UiBudget(),
    expire: vi.fn(async () => 0),
    keys: new UiStepKeys(),
  };
  return { deps, rows, emitted };
}

describe('runUiCall', () => {
  it('opens one row keyed on the turn and the tool call, asks the window, returns its result', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true, route: '/pages' } });
    const res = await runUiCall('navigate', { path: '/pages' }, ctx(WEB), f.deps);
    expect(res).toEqual({ ok: true, output: { ok: true, route: '/pages' } });
    expect([...f.rows.keys()]).toEqual([uiStepKey(TURN, 'call_1')]);
    expect(f.emitted).toEqual([
      { callId: CALL, action: 'navigate', args: { path: '/pages' }, expiresAt: expect.any(String) },
    ]);
  });

  it('a re-run of the turn (a new process: its keys count again) reuses the row and does not ask the window twice', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true } });
    await runUiCall('click', { target: { ref: 'e1' } }, ctx(WEB), f.deps);
    f.deps.keys = new UiStepKeys();
    await runUiCall('click', { target: { ref: 'e1' } }, ctx(WEB), f.deps);
    expect(f.rows.size).toBe(1);
    expect(f.emitted.length).toBe(1);
    // Another tool call of the turn is another row.
    await runUiCall('click', { target: { ref: 'e1' } }, ctx(WEB, 'call_2'), f.deps);
    expect(f.rows.size).toBe(2);
  });

  it('two fallback-id calls in one turn (a provider sent no id: `call_<name>`) both act', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true } });
    const a = await runUiCall(
      'click',
      { target: { ref: 'e1' } },
      ctx(WEB, 'call_ui_click'),
      f.deps,
    );
    const b = await runUiCall(
      'click',
      { target: { ref: 'e2' } },
      ctx(WEB, 'call_ui_click'),
      f.deps,
    );
    expect(a.ok && b.ok).toBe(true);
    expect([...f.rows.keys()]).toEqual([
      uiStepKey(TURN, 'call_ui_click'),
      uiStepKey(TURN, 'call_ui_click', 2),
    ]);
    // Both reached the window, each with its own target.
    expect(f.emitted).toEqual([
      expect.objectContaining({ args: { target: { ref: 'e1' } } }),
      expect.objectContaining({ args: { target: { ref: 'e2' } } }),
    ]);
    // Another turn starts its own count.
    f.deps.turnId = () => 'turn-2';
    await runUiCall('click', { target: { ref: 'e1' } }, ctx(WEB, 'call_ui_click'), f.deps);
    expect(f.rows.has(uiStepKey('turn-2', 'call_ui_click'))).toBe(true);
  });

  it('a re-run after a restart finds both fallback-id rows again, in order', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true } });
    for (const ref of ['e1', 'e2']) {
      await runUiCall('click', { target: { ref } }, ctx(WEB, 'call_ui_click'), f.deps);
    }
    f.deps.keys = new UiStepKeys();
    for (const ref of ['e1', 'e2']) {
      await runUiCall('click', { target: { ref } }, ctx(WEB, 'call_ui_click'), f.deps);
    }
    expect(f.rows.size).toBe(2);
    expect(f.emitted).toHaveLength(2);
  });

  it('the step keys of a turn no call touched for an hour are dropped', () => {
    let t = 0;
    const k = new UiStepKeys(() => t);
    expect(k.next('a', 'c')).toBe('1:a:1:c');
    expect(k.next('a', 'c')).toBe('1:a:1:c#2');
    t += 61 * 60_000;
    expect(k.next('b', 'c')).toBe('1:b:1:c');
    expect(k.next('a', 'c')).toBe('1:a:1:c');
  });

  it('no turn id or call id makes one step key read as another', () => {
    // An Idempotency-Key may hold ':' and '#': split differently, the same
    // joined text would name two calls.
    const pairs: [string, string, number][] = [
      ['t:a', 'b', 1],
      ['t', 'a:b', 1],
      ['t', 'c#2', 1],
      ['t', 'c', 2],
      ['t:1:c', 'x', 1],
      ['t', '1:c:x', 1],
    ];
    const keys = pairs.map(([turn, call, n]) => uiStepKey(turn, call, n));
    expect(new Set(keys).size).toBe(pairs.length);
  });

  it('ui_type sends the window an explicit replace: false when the model left it out', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true } });
    await runUiCall('type', { target: { ref: 'e1' }, text: 'more' }, ctx(WEB), f.deps);
    expect(f.emitted).toEqual([
      expect.objectContaining({ args: { target: { ref: 'e1' }, text: 'more', replace: false } }),
    ]);
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

describe("a member's workspace turn: the ui budget (12 calls, 3 minutes of waiting)", () => {
  const TEAM = { kind: 'team' as const, loginId: LOGIN, uiWindowId: WINDOW };

  it('the 13th call answers at once with the budget refusal, before any row', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true } });
    for (let i = 1; i <= UI_TEAM_MAX_CALLS; i++) {
      const res = await runUiCall('screen', {}, ctx(TEAM, `call_${i}`), f.deps);
      expect(res.ok, `call ${i}`).toBe(true);
    }
    const opened = vi.mocked(f.deps.open).mock.calls.length;
    const res = await runUiCall('screen', {}, ctx(TEAM, 'call_13'), f.deps);
    expect(res).toEqual({ ok: false, error: UI_BUDGET_ERROR });
    expect(UI_BUDGET_ERROR.startsWith('ui_budget: ui budget used for this turn')).toBe(true);
    expect(vi.mocked(f.deps.open).mock.calls.length).toBe(opened);
  });

  it('three minutes of waiting in all: the wait is cut to what is left, then every call refuses', async () => {
    const f = fakeCall({ status: 'pending', result: null });
    let t = 0;
    f.deps.wait.now = () => t;
    f.deps.wait.pause = async (_id, ms) => {
      t += ms;
    };
    // Each unanswered call waits its 15 s TTL: 12 of them are 180 s, the cap.
    const ttls = UI_TEAM_MAX_WAIT_MS / AGENT_UI_CALL_TTL_MS;
    for (let i = 1; i <= ttls; i++) {
      const res = await runUiCall('screen', {}, ctx(TEAM, `call_${i}`), f.deps);
      expect(!res.ok && res.error.startsWith('window_gone:'), `call ${i}`).toBe(true);
    }
    expect(t).toBe(UI_TEAM_MAX_WAIT_MS);
    const res = await runUiCall('screen', {}, ctx(TEAM, 'call_x'), f.deps);
    expect(res).toEqual({ ok: false, error: UI_BUDGET_ERROR });
    expect(t).toBe(UI_TEAM_MAX_WAIT_MS);
  });

  it('a wait the budget cuts short is the budget refusal, and gives up the open calls', async () => {
    const budget = new UiBudget();
    budget.waited(TURN, UI_TEAM_MAX_WAIT_MS - 1_000); // one second left
    const f = fakeCall({ status: 'pending', result: null });
    f.deps.budget = budget;
    let t = 0;
    f.deps.wait.now = () => t;
    f.deps.wait.pause = async (_id, ms) => {
      t += ms;
    };
    const res = await runUiCall('screen', {}, ctx(TEAM), f.deps);
    expect(res).toEqual({ ok: false, error: UI_BUDGET_ERROR });
    expect(t).toBe(1_000);
    expect(f.deps.expire).toHaveBeenCalledWith({ turnId: TURN, loginId: LOGIN });
  });

  it('per turn: another turn has its own budget, and an owner turn has none', async () => {
    const f = fakeCall({ status: 'done', result: { ok: true } });
    for (let i = 1; i <= UI_TEAM_MAX_CALLS; i++) {
      await runUiCall('screen', {}, ctx(TEAM, `call_${i}`), f.deps);
    }
    expect(await runUiCall('screen', {}, ctx(TEAM, 'over'), f.deps)).toEqual({
      ok: false,
      error: UI_BUDGET_ERROR,
    });
    f.deps.turnId = () => 'turn-2';
    expect((await runUiCall('screen', {}, ctx(TEAM, 'other'), f.deps)).ok).toBe(true);
    f.deps.turnId = () => TURN;
    for (let i = 1; i <= UI_TEAM_MAX_CALLS + 3; i++) {
      const res = await runUiCall('screen', {}, ctx(WEB, `web_${i}`), f.deps);
      expect(res.ok, `owner call ${i}`).toBe(true);
    }
  });

  it('an entry no call touched for an hour is dropped', () => {
    let t = 0;
    const b = new UiBudget(() => t);
    for (let i = 0; i < UI_TEAM_MAX_CALLS; i++) expect(b.take('old')).not.toBeNull();
    expect(b.take('old')).toBeNull();
    t += 61 * 60_000;
    b.take('fresh');
    expect(b.take('old')).toBe(UI_TEAM_MAX_WAIT_MS);
  });
});

describe("a turn's end (endTurnUiCalls)", () => {
  const t = { windowId: WINDOW, streamId: TURN, loginId: LOGIN };

  it("clears the turn's own calls: its stream id and its login", async () => {
    const clear = vi.fn(async () => 2);
    await endTurnUiCalls(t, { clear });
    expect(clear).toHaveBeenCalledWith({ turnId: TURN, loginId: LOGIN });
  });

  it('a turn with no window, no stream or no login made no call: nothing is asked', async () => {
    const clear = vi.fn(async () => 0);
    await endTurnUiCalls({ ...t, windowId: undefined }, { clear });
    await endTurnUiCalls({ ...t, streamId: null }, { clear });
    await endTurnUiCalls({ ...t, loginId: undefined }, { clear });
    expect(clear).not.toHaveBeenCalled();
  });

  it('never throws: a failed clear is logged (the nightly sweep takes the rows)', async () => {
    const clear = vi.fn(async () => {
      throw new Error('database down');
    });
    await expect(endTurnUiCalls(t, { clear })).resolves.toBeUndefined();
  });
});
