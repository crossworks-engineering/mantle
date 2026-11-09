/**
 * How one call of a running app's tool is judged and where it runs: the
 * ONE plan both app tool paths take, the app tool broker
 * (server/web/lib/app-tool-broker.ts, a person's host.tools.call) and the
 * app timers (app-timers/run.ts, the same call on a clock). Before it was
 * shared, the timer copied the broker's steps; now a change to who runs at
 * which rules reaches both (app-tool-run.test.ts holds the table).
 *
 *  - who runs it: `owner` (an Admin user: the rules the app's holders and
 *    author allow, appToolLevel 'admin'), `member` (the team rules,
 *    whatever the author), or `contact` (a contact share, past its code
 *    gate: contactAppToolVerdict);
 *  - the verdict on the app's declared tools (appToolVerdict, with the
 *    login and the call's input where the rules ask for them);
 *  - the surface and the scope the dispatch runs in (appToolScope): at
 *    team rules the runner's own rights (the login's union of workspaces,
 *    as by hand), for a contact the link's served items, at admin rules
 *    `adminScope` decides: 'caller' runs in the scope the caller is in
 *    (the broker: the Admin user's own request, as before), 'login' in the
 *    login's own scope (a timer: no request, so the login's union of
 *    workspaces, read only);
 *  - whether the owner's confirmation applies (admin rules on the owner
 *    route only).
 */
import type { ViewerFor } from '@mantle/db';
import type { AppAuthorLevel } from '@mantle/db';
import type { AppToolRules } from '@mantle/content';
import {
  appToolLevel,
  appToolScope,
  appToolVerdict,
  type AppCallRules,
  type AppToolVerdict,
} from './app-tool-level';
import { contactAppToolVerdict } from './external-access';
import type { ToolHandlerContext } from './types';

/** The app as a run reads it. */
export type AppToolRunApp = {
  id: string;
  manifest: { toolSlugs?: readonly string[] | null };
  toolRules?: AppToolRules | null;
  authorLevel?: AppAuthorLevel;
};

/** Who runs the app: a login, named on the team surface and in the logs. */
export type AppToolRunLogin = { loginId: string; name: string };

/** Who runs the app, and how. */
export type AppToolRunConfig =
  | {
      via: 'owner' | 'member';
      ownerId: string;
      runner: AppToolRunLogin;
      /** Where a run at admin rules dispatches: the caller's own scope as
       *  it is ('caller', default), or the login's own ('login'). */
      adminScope?: 'caller' | 'login';
    }
  | {
      via: 'contact';
      ownerId: string;
      share: { id: string; contactId: string };
      /** The items the link serves: all a call of it reads. */
      served: () => Promise<readonly string[]>;
    };

type Surface = NonNullable<ToolHandlerContext['surface']>;

/** One call's plan (see the head). */
export type AppToolRunPlan = {
  rules: AppCallRules;
  verdict: () => Promise<AppToolVerdict>;
  /** The owner's confirmation applies (admin rules, the owner route). */
  confirm: boolean;
  surface: Surface;
  /** The viewer scope the dispatch runs in, read once the call is allowed;
   *  null: as it is (the caller's own). */
  actsFor: () => Promise<ViewerFor | null>;
};

/** The plan of one call of `slug` with `input` in `app`, run as `config`
 *  says (see the head). */
export function appToolRunPlan(
  config: AppToolRunConfig,
  app: AppToolRunApp,
  slug: string,
  input: Readonly<Record<string, unknown>>,
): AppToolRunPlan {
  const declared = app.manifest.toolSlugs ?? [];
  if (config.via === 'contact') {
    const { share, served } = config;
    return {
      rules: 'contact',
      verdict: () => contactAppToolVerdict(config.ownerId, declared, slug),
      confirm: false,
      surface: { kind: 'contact', contactId: share.contactId, shareId: share.id },
      // A link reads no workspace, only what it serves, never a
      // snapshot copy.
      actsFor: async () => ({ link: { served: [...(await served())] } }),
    };
  }
  // The owner's run: the rules the app's holders and its author allow (a
  // member-built app, or one a workspace other than Admin holds, runs the
  // team rules for an admin too). A member's run: the team rules, whatever
  // the app's author.
  const level =
    config.via === 'owner'
      ? appToolLevel('admin', app.toolRules, app.authorLevel)
      : appToolLevel('team', 'team', 'admin');
  // A member's login: a connector tool also needs the login's workspace
  // rule, as on that login's own MCP (which workspaces hold the app does not
  // count, 2026-11-09).
  // The admin's own rule applies to an admin-level run; a team-level one
  // keeps the Team rule, so the admin's own connectors never lift an
  // author-limited app above what it runs with for its members.
  const loginId = config.via === 'member' || level !== 'team' ? config.runner.loginId : undefined;
  // The call's input names the Table a team app's row write changes
  // (member-app-tools.ts rule 6: one the runner may write by hand).
  const check = config.via === 'member' || level !== 'admin' ? { input } : undefined;
  const scope = level === 'none' ? null : appToolScope(level, config.runner);
  const adminScope = config.adminScope ?? 'caller';
  return {
    rules: level,
    verdict: () => appToolVerdict(level, config.ownerId, declared, slug, loginId, check),
    confirm: config.via === 'owner' && level === 'admin',
    // appToolVerdict refuses every call at 'none', so no scope is needed.
    surface: scope?.surface ?? { kind: 'web' },
    // An app the Admin workspace alone holds runs as the owner's web
    // surface: in the caller's own scope, or the login's when asked; any
    // other as an app run of the login (its own rights, read only).
    actsFor: async () => {
      if (!scope) return null;
      if (scope.viewer !== 'admin') return scope.actsFor;
      return adminScope === 'login' ? { login: config.runner.loginId } : null;
    },
  };
}

/** Whether no run of `app` could be at admin rules now: an Admin user's own
 *  run would get the team rules (a workspace other than Admin holds it, or
 *  a member built it) or none. Then nothing read at admin rules may stay
 *  where the app's runners read it (the app timers' run log). */
export function appHeldBelowAdmin(app: Pick<AppToolRunApp, 'toolRules' | 'authorLevel'>): boolean {
  return appToolLevel('admin', app.toolRules, app.authorLevel) !== 'admin';
}
