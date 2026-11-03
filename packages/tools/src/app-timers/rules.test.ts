/**
 * The app timer rule (docs/app-timers.md): which tools a timer may call,
 * how often, and with which arguments. Pure: the builtin registry's
 * policies, no database. (The back-off and the next run are the
 * database's, store.ts finishAppTimerRun: app-timers.db.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';
import { BUILTIN_TOOLS } from '../builtins';
import '../registry';
import { externalAccessToolSig } from '../external-access';
import { APP_TIMER_RUNS_TABLE as RUNNER_TABLE } from '@mantle/content/app-broker';
import {
  APP_TIMER_HTTP_MIN_MINUTES,
  APP_TIMER_MEMBER_MIN_MINUTES,
  APP_TIMER_MIN_MINUTES,
  APP_TIMER_RUNS_TABLE,
  firstRunAfter,
  timerArgsProblem,
  timerToolVerdict,
} from './rules';

/** The tool row of a builtin, as resolveTool reads it. */
const builtin = (slug: string, over: Partial<Tool> = {}): Tool =>
  ({
    slug,
    handler: { kind: 'builtin', ref: slug },
    requiresConfirm: false,
    externalAccess: null,
    description: '',
    inputSchema: {},
    ...over,
  }) as unknown as Tool;

const policyOf = (slug: string) => BUILTIN_TOOLS.find((t) => t.slug === slug)!.policy;

describe('timerToolVerdict', () => {
  it('a declared built-in read that spends nothing: allowed', () => {
    expect(policyOf('calculate')).toMatchObject({ effect: 'read', spends: 'none' });
    expect(timerToolVerdict(builtin('calculate'), 'calculate', ['calculate'], false)).toEqual({
      ok: true,
      minMinutes: APP_TIMER_MEMBER_MIN_MINUTES,
    });
    expect(timerToolVerdict(builtin('calculate'), 'calculate', ['calculate'], true)).toEqual({
      ok: true,
      minMinutes: APP_TIMER_MIN_MINUTES,
    });
  });

  it('a tool the app does not declare: refused, whatever it is', () => {
    const v = timerToolVerdict(builtin('calculate'), 'calculate', ['box_status'], true);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/does not declare the tool 'calculate'/);
  });

  it('no such tool: refused', () => {
    expect(timerToolVerdict(null, 'gone_tool', ['gone_tool'], true).ok).toBe(false);
  });

  it('a write tool: refused, for an Admin user too', () => {
    expect(policyOf('app_tools_set').effect).toBe('write');
    const v = timerToolVerdict(builtin('app_tools_set'), 'app_tools_set', ['app_tools_set'], true);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/read and spend nothing/);
  });

  it('every built-in a timer may call is a read that spends nothing and starts no model work', () => {
    for (const def of BUILTIN_TOOLS) {
      const ok = timerToolVerdict(builtin(def.slug), def.slug, [def.slug], true).ok;
      if (!ok) continue;
      expect(def.policy.effect, def.slug).toBe('read');
      expect(def.policy.spends, def.slug).toBe('none');
      expect(def.policy.startsModelWork, def.slug).toBeUndefined();
      expect(['shell', 'sandbox']).not.toContain(def.policy.outside?.via);
    }
  });

  it('a read that starts model work or spends: refused', () => {
    const spender = BUILTIN_TOOLS.find(
      (t) => t.policy.effect === 'read' && (t.policy.startsModelWork || t.policy.spends !== 'none'),
    );
    expect(spender).toBeDefined();
    expect(timerToolVerdict(builtin(spender!.slug), spender!.slug, [spender!.slug], true).ok).toBe(
      false,
    );
  });

  it('a risky read (peer_status): an Admin user only', () => {
    expect(policyOf('peer_status')).toMatchObject({
      effect: 'read',
      spends: 'none',
      peerRisky: true,
    });
    const member = timerToolVerdict(builtin('peer_status'), 'peer_status', ['peer_status'], false);
    expect(member.ok).toBe(false);
    expect(!member.ok && member.reason).toMatch(/only an Admin user/);
    expect(timerToolVerdict(builtin('peer_status'), 'peer_status', ['peer_status'], true)).toEqual({
      ok: true,
      minMinutes: APP_TIMER_MIN_MINUTES,
    });
  });

  it('a tool that needs the owner to confirm: refused', () => {
    const v = timerToolVerdict(
      builtin('calculate', { requiresConfirm: true }),
      'calculate',
      ['calculate'],
      true,
    );
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/confirmation/);
  });

  it('an HTTP tool: only with External access on (it only reads)', () => {
    const handler = { kind: 'http', url: 'https://api.example.test/x', method: 'GET' };
    const row = {
      slug: 'weather',
      handler,
      requiresConfirm: false,
      description: 'd',
      inputSchema: {},
      externalAccess: null,
    } as unknown as Tool;
    expect(timerToolVerdict(row, 'weather', ['weather'], true).ok).toBe(false);
    const marked = {
      ...row,
      externalAccess: {
        confirmedReadOnlyAt: '2026-11-01T00:00:00Z',
        by: 'x',
        handlerSig: externalAccessToolSig(row),
      },
    } as unknown as Tool;
    expect(timerToolVerdict(marked, 'weather', ['weather'], false)).toEqual({
      ok: true,
      minMinutes: APP_TIMER_HTTP_MIN_MINUTES,
    });
    // One that sends a vault secret: an Admin user only, every 15 minutes.
    const secretHandler = {
      ...handler,
      headers: { Authorization: 'Bearer {{secret:example/token}}' },
    };
    const secret = { ...row, handler: secretHandler } as unknown as Tool;
    const secretMarked = {
      ...secret,
      externalAccess: {
        confirmedReadOnlyAt: '2026-11-01T00:00:00Z',
        by: 'x',
        handlerSig: externalAccessToolSig(secret),
      },
    } as unknown as Tool;
    const below = timerToolVerdict(secretMarked, 'weather', ['weather'], false);
    expect(!below.ok && below.reason).toMatch(/vault secret: only an Admin user/);
    expect(timerToolVerdict(secretMarked, 'weather', ['weather'], true)).toEqual({
      ok: true,
      minMinutes: APP_TIMER_HTTP_MIN_MINUTES,
    });
  });

  it('a connector, a recipe or a shell tool: refused', () => {
    for (const kind of ['mcp', 'recipe', 'shell']) {
      const row = builtin('x', { handler: { kind } as unknown as Tool['handler'] });
      const v = timerToolVerdict(row, 'x', ['x'], true);
      expect(v.ok, kind).toBe(false);
    }
  });

  it('a policy that changes is read again: the same row refused once its tool writes', () => {
    // The rule reads the live registry: a builtin row whose ref is a write
    // (as after a policy change) is refused, though its slug was a read.
    const swapped = builtin('calculate', {
      handler: { kind: 'builtin', ref: 'app_tools_set' } as unknown as Tool['handler'],
    });
    expect(timerToolVerdict(swapped, 'calculate', ['calculate'], true).ok).toBe(false);
  });
});

describe('the run log name', () => {
  it('is the reserved table the app SQL runner guards', () => {
    expect(APP_TIMER_RUNS_TABLE).toBe(RUNNER_TABLE);
  });
});

describe('the arguments', () => {
  it('fit the tool input schema: its required ones, their types, no unknown one on a closed schema', () => {
    const schema = {
      type: 'object',
      properties: { expression: { type: 'string' }, to: { type: 'string' } },
      required: ['expression'],
      additionalProperties: false,
    };
    const tool = { slug: 'calculate', inputSchema: schema } as unknown as Tool;
    expect(timerArgsProblem(tool, { expression: '1 + 1' })).toBeNull();
    expect(timerArgsProblem(tool, {})).toMatch(/expression/);
    expect(timerArgsProblem(tool, { expression: '1', bogus: 1 })).toMatch(/bogus/);
  });
});

describe('a new timer', () => {
  const at = new Date('2026-11-03T10:00:00Z');
  it('runs within half a minute', () => {
    expect(firstRunAfter(at, () => 0).getTime()).toBe(at.getTime());
    expect(firstRunAfter(at, () => 0.999999).getTime() - at.getTime()).toBeLessThan(30_000);
  });
});
