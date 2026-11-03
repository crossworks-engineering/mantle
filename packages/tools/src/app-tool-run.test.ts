/**
 * The one plan of an app tool call (app-tool-run.ts appToolRunPlan): the
 * rules, the surface, the scope and the confirmation for every way an app
 * runs, and that both paths take it: the app tool broker
 * (server/web/lib/app-tool-broker.ts) and the app timers
 * (app-timers/run.ts), with no copy of its steps left in either.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appToolRunPlan, type AppToolRunConfig } from './app-tool-run';

const ROOT = join(__dirname, '../../..');
const login = { loginId: '11111111-1111-4111-8111-111111111111', name: 'Ada' };
const app = (toolRules: 'admin' | 'team', authorLevel: 'admin' | 'team' = 'admin') => ({
  id: '22222222-2222-4222-8222-222222222222',
  manifest: { toolSlugs: ['calculate'] },
  toolRules,
  authorLevel,
});
const plan = (config: AppToolRunConfig, a = app('admin')) =>
  appToolRunPlan(config, a, 'calculate', { expression: '1' });
const owner = (adminScope?: 'caller' | 'login'): AppToolRunConfig => ({
  via: 'owner',
  ownerId: 'o',
  runner: login,
  ...(adminScope ? { adminScope } : {}),
});

describe('appToolRunPlan', () => {
  it('an Admin user, an app the Admin workspace alone holds: admin rules, the web surface, the confirmation', async () => {
    const p = plan(owner());
    expect(p.rules).toBe('admin');
    expect(p.confirm).toBe(true);
    expect(p.surface).toEqual({ kind: 'web', loginId: login.loginId });
    // The broker: the caller's own request scope.
    expect(await p.actsFor()).toBeNull();
    // A timer: the login's own scope (no request to run in).
    expect(await plan(owner('login')).actsFor()).toEqual({ login: login.loginId });
  });

  it("an Admin user, an app another workspace holds or a member built: team rules, the app's scope, no confirmation", async () => {
    for (const a of [app('team'), app('admin', 'team')]) {
      for (const scope of ['caller', 'login'] as const) {
        const p = plan(owner(scope), a);
        expect(p.rules).toBe('team');
        expect(p.confirm).toBe(false);
        expect(p.surface).toMatchObject({ kind: 'team', loginId: login.loginId });
        expect(await p.actsFor()).toEqual({ login: login.loginId, app: { id: a.id } });
      }
    }
  });

  it("a member: team rules whatever the app, the app's scope", async () => {
    for (const a of [app('admin'), app('team')]) {
      const p = plan({ via: 'member', ownerId: 'o', runner: login, adminScope: 'login' }, a);
      expect(p.rules).toBe('team');
      expect(p.confirm).toBe(false);
      expect(await p.actsFor()).toEqual({ login: login.loginId, app: { id: a.id } });
    }
  });

  it("a contact: the contact rules, the link's served items", async () => {
    const p = plan({
      via: 'contact',
      ownerId: 'o',
      share: { id: 's', contactId: 'c' },
      served: async () => ['n1'],
    });
    expect(p.rules).toBe('contact');
    expect(p.confirm).toBe(false);
    expect(p.surface).toEqual({ kind: 'contact', contactId: 'c', shareId: 's' });
    expect(await p.actsFor()).toEqual({ link: { served: ['n1'] } });
  });
});

describe('both app tool paths take the one plan', () => {
  const STEPS = /\b(appToolLevel|appToolScope|appToolVerdict|contactAppToolVerdict)\s*\(/;
  for (const [file, scope] of [
    ['server/web/lib/app-tool-broker.ts', "adminScope: 'caller'"],
    ['packages/tools/src/app-timers/run.ts', "adminScope: 'login'"],
  ] as const) {
    it(`${file} plans with appToolRunPlan and copies none of its steps`, () => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text).toMatch(/\bappToolRunPlan\(/);
      expect(text).toContain(scope);
      expect(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(STEPS);
    });
  }
});
