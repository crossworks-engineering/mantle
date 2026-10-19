/**
 * The one scope check (gateway/scope.ts scopeProblem; arch A3c fix round 2, L-d):
 * withScope and withTurnScope (and the gate, through turnScopeProblem) ask
 * the same function, each in its own words. These are the words each said
 * before the check was one, pinned: no caller's error text changes. Every
 * case fails before any database call.
 */
import { describe, expect, it } from 'vitest';
import { turnScopeProblem, withScope, withTurnScope } from './client';
import type { WorkspaceScope } from './viewer';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const scope = (over: Partial<WorkspaceScope>): WorkspaceScope => ({
  kind: 'user',
  loginId: A,
  ws: [A],
  modWs: [],
  ...over,
});
const never = async () => {
  throw new Error('fn must not run');
};

describe('withScope: its own words, as before', () => {
  it.each([
    [{ loginId: 'nope' }, 'withScope: loginId must be a uuid'],
    [{ ws: ['nope'] }, 'withScope ws: not a uuid: nope'],
    [{ modWs: ['nope'] }, 'withScope modWs: not a uuid: nope'],
    [{ ws: [A], modWs: [B] }, 'withScope: modWs must be a subset of ws'],
    // The order: the login, then the workspaces, then the Moderator ones.
    [{ loginId: 'x', ws: ['y'] }, 'withScope: loginId must be a uuid'],
    [{ ws: ['y'], modWs: ['z'] }, 'withScope ws: not a uuid: y'],
  ] as const)('%o', async (over, message) => {
    await expect(withScope(scope(over), never)).rejects.toThrow(new Error(message));
  });

  it('passes no workspace at all (needsWorkspace false: an empty list reads nothing)', async () => {
    // The check after the workspace one answers, so the empty list itself
    // was let through; a turn refuses the same scope for having none.
    await expect(withScope(scope({ ws: [], modWs: [B] }), never)).rejects.toThrow(
      new Error('withScope: modWs must be a subset of ws'),
    );
    expect(turnScopeProblem(scope({ ws: [], modWs: [B] }))).toBe(
      'withTurnScope: a turn reads at least one workspace',
    );
    // The source: withScope asks the one check without the workspace rule.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./gateway/scope.ts', import.meta.url), 'utf8');
    expect(src).toContain("scopeProblem(scope, 'withScope', { needsWorkspace: false })");
  });

  it('cuts a long id at 40 characters, as before', async () => {
    const long = 'x'.repeat(60);
    await expect(withScope(scope({ ws: [long] }), never)).rejects.toThrow(
      `withScope ws: not a uuid: ${'x'.repeat(40)}`,
    );
  });
});

describe('withTurnScope and the gate: the turn words, as before', () => {
  it.each([
    [{ loginId: 'nope' }, 'withTurnScope: loginId must be a uuid'],
    [{ ws: ['nope'] }, 'withTurnScope ws: not a uuid: nope'],
    [{ modWs: ['nope'] }, 'withTurnScope modWs: not a uuid: nope'],
    [{ ws: [] }, 'withTurnScope: a turn reads at least one workspace'],
    [{ ws: [A], modWs: [B] }, 'withTurnScope: modWs must be a subset of ws'],
  ] as const)('%o', async (over, message) => {
    expect(turnScopeProblem(scope(over))).toBe(message);
    await expect(withTurnScope(scope(over), never)).rejects.toThrow(new Error(message));
  });

  it('a well formed scope has no problem', () => {
    expect(turnScopeProblem(scope({ ws: [A, B], modWs: [B] }))).toBeNull();
  });
});
