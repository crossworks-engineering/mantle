/**
 * The ONE rule for the rules an app's tools run under (client tier audit
 * 2026-09-30, L1; workspaces W5b2, plan R2). The three app tool brokers
 * (owner, member, client) and the author warnings all ask here, so they
 * cannot drift.
 *
 * Why: an app's database is shared by everyone who runs the app, so the app
 * reads only what EVERY holder of the app reads (R2): a tool that reads more
 * would let one runner copy it into data the other holders read. The
 * holders are the workspaces its grants name (`AppRuntime.toolRules`): an
 * app the Admin workspace alone holds keeps the runner's own rules; an app
 * any other workspace holds (Team, or a workspace of its own) runs the team
 * rules for EVERY runner, an admin's run included. (A one-user private
 * workspace whose user is also in another holder will not count as a
 * holder: private workspaces come with W6b.) Clients are not migrated
 * (owner rule 21.9): the client rules run only for the client portal's own
 * apps (client-apps.ts), never for a workspace app.
 *
 *   runner \ held by   Admin only   another workspace   client portal app
 *   admin              admin        team                (never)
 *   member             team         team                (never)
 *   client             (never)      (never)             client
 *
 * AUTHOR CEILING (team apps Phase 3, plan A.4): an app a member built
 * (`apps.author_level` 'team') runs its tools at most at team rules, for
 * every runner: an admin who opens it gets `team`, never `admin`, so a
 * member cannot ship an app that fires an admin tool the first time an
 * admin runs it. Only an admin's accept with the declared tools reviewed
 * lifts it.
 *
 * `admin` is the owner broker's rule as it always was (declared, exists);
 * `team` is memberAppToolVerdict; `client` is clientAppToolVerdict; `none`
 * refuses every tool.
 */
import type { AppAuthorLevel, Tool, ViewerLevel } from '@mantle/db';
import { getAppRuntime, type AppToolRules } from '@mantle/content';
import { resolveTool } from './resolve';
import { memberAppToolVerdict } from './member-app-tools';
import { clientAppToolVerdict } from './client-app-tools';
import type { OutsideToolCheck } from './external-access';
import type { ToolHandlerContext } from './types';

/** The rules an app's tool call runs under. */
export type AppToolLevel = 'admin' | 'team' | 'client' | 'none';

/** Who runs the app: the owner broker's admin, a member or a client. */
export type AppToolRunner = 'admin' | 'team' | 'client';

/** What the app's holders allow (`AppRuntime.toolRules`), or 'client' for
 *  an app of the client portal (the client broker). */
export type AppHolding = AppToolRules | 'client';

/** `write`: an outside call that writes (team apps Phase 2); the member
 *  and client brokers log its input. */
export type AppToolVerdict =
  { ok: true; tool: Tool; write?: boolean } | { ok: false; status: 403 | 404; reason: string };

/** The rules a run gets: see the table above. Anything but a known holding
 *  runs no tools. Then the author ceiling: a member-built app
 *  (`authorLevel` 'team') never runs at admin rules. */
export function appToolLevel(
  runner: AppToolRunner,
  holding: AppHolding | null | undefined,
  authorLevel: AppAuthorLevel = 'admin',
): AppToolLevel {
  let byHolders: AppToolLevel;
  if (holding === 'client') byHolders = runner === 'client' ? 'client' : 'none';
  else if (runner === 'client') byHolders = 'none';
  else if (holding === 'team') byHolders = 'team';
  else if (holding === 'admin') byHolders = runner;
  else byHolders = 'none';
  return byHolders === 'admin' && authorLevel === 'team' ? 'team' : byHolders;
}

const notDeclared = (slug: string) =>
  `This app isn't allowed to use the tool '${slug}'. It must be declared in the app's tools before it can run.`;

/** Why a run gets no tools (a client run of a non-client app, never reached). */
export const APP_NO_TOOLS = "This app can't use tools here.";

/** May a run at `level` of an app that declares `declared` call `slug`?
 *  `loginId`: who runs it, when known; a connector tool then also needs the
 *  login's workspace rule (loginConnectorRule, W4b fix round 2), the same
 *  as the login's own MCP. */
export async function appToolVerdict(
  level: AppToolLevel,
  ownerId: string,
  declared: readonly string[],
  slug: string,
  loginId?: string,
  check?: OutsideToolCheck,
): Promise<AppToolVerdict> {
  switch (level) {
    case 'client':
      return clientAppToolVerdict(ownerId, declared, slug, loginId, check);
    case 'team':
      return memberAppToolVerdict(ownerId, declared, slug, loginId, check);
    case 'admin': {
      if (!declared.includes(slug)) return { ok: false, status: 403, reason: notDeclared(slug) };
      const tool = await resolveTool(ownerId, slug);
      if (!tool) return { ok: false, status: 404, reason: `tool '${slug}' not found` };
      return { ok: true, tool };
    }
    case 'none':
      return { ok: false, status: 403, reason: APP_NO_TOOLS };
  }
}

/**
 * Where an allowed call runs: the viewer scope and the surface (a call at
 * 'none' is never allowed, and throws). `admin` is
 * the owner's web surface, as the owner broker always ran; `team` and
 * `client` are the member and client brokers' surfaces, naming the runner's
 * login (for an admin who runs a lower app, the admin's own login).
 */
export function appToolScope(
  level: AppToolLevel,
  runner: { loginId: string; name: string },
): { viewer: ViewerLevel; surface: NonNullable<ToolHandlerContext['surface']> } {
  switch (level) {
    case 'none':
      // appToolVerdict refuses every call at 'none', so nothing gets here.
      throw new Error(APP_NO_TOOLS);
    case 'admin':
      return { viewer: 'admin', surface: { kind: 'web' } };
    case 'team':
      return {
        viewer: 'team',
        surface: {
          kind: 'team',
          loginId: runner.loginId,
          contactName: runner.name,
          privateReads: false,
        },
      };
    case 'client':
      return {
        viewer: 'client',
        surface: { kind: 'client', loginId: runner.loginId, contactName: runner.name },
      };
  }
}

/**
 * For an app a workspace other than Admin holds: one warning per declared
 * tool its runs would refuse, in the broker's own words (the team rules run
 * for every runner, R2). An app the Admin workspace alone holds gets none,
 * unless a member built it (the author ceiling runs it at team rules for its
 * admins too). Given back by every author move that can change the answer:
 * `app_tools_set`, `app_publish`, a grant change and moving it into another
 * folder (`movedAppToolWarnings`). Best-effort: a failed check warns nothing
 * and never fails the move it rides on.
 */
export async function appToolWarnings(ownerId: string, appId: string): Promise<string[]> {
  try {
    const app = await getAppRuntime(ownerId, appId);
    if (!app) return [];
    const level = appToolLevel('admin', app.toolRules, app.authorLevel);
    if (level !== 'team') return [];
    const declared = [...new Set(app.manifest.toolSlugs ?? [])];
    const warnings: string[] = [];
    for (const slug of declared) {
      // No run here, so no runner login: the rules alone.
      const verdict = await appToolVerdict(level, ownerId, declared, slug, undefined, {
        rulesOnly: true,
      });
      if (verdict.ok) continue;
      warnings.push(
        `${verdict.reason} Everyone running this app (admins too) gets an error: an app a workspace other than Admin holds runs the team rules. Declare a read-only built-in tool from an enabled team-level group instead (\`tool_group_list\` shows levels), have an admin open a connector to that workspace, switch External access on for an http tool that only reads, or keep the app in the Admin workspace only.`,
      );
    }
    return warnings;
  } catch {
    return [];
  }
}

/**
 * The tool warnings of apps a move filed into another folder (access matrix
 * N11): an app placed in a folder takes its grants (S6), and its holders set
 * the rules its tools run under (R2), so moving an app changes which of its
 * declared tools run, for its admins too. Each warning names its app when
 * more than one moved. Best-effort, as appToolWarnings.
 */
export async function movedAppToolWarnings(
  ownerId: string,
  appIds: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of appIds) {
    const warnings = await appToolWarnings(ownerId, id);
    out.push(...(appIds.length > 1 ? warnings.map((w) => `App ${id}: ${w}`) : warnings));
  }
  return out;
}
