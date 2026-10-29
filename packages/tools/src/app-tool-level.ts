/**
 * The ONE rule for the rules an app's tools run under. The app tool brokers
 * (owner, member) and the author warnings all ask here, so they cannot drift.
 *
 * Why: an app's database is shared by everyone who runs the app, so the app
 * reads only what EVERY holder of the app reads: a tool that reads more
 * would let one runner copy it into data the other holders read. The
 * holders are the workspaces its grants name (`AppRuntime.toolRules`): an
 * app the Admin workspace alone holds keeps the runner's own rules; an app
 * any other workspace holds (Team, or a workspace of its own) runs the team
 * rules for EVERY runner, an admin's run included. Clients run no apps.
 *
 *   runner \ held by   Admin only   another workspace
 *   admin              admin        team
 *   member             team         team
 *
 * AUTHOR CEILING: an app a member built
 * (`apps.author_level` 'team') runs its tools at most at team rules, for
 * every runner: an admin who opens it gets `team`, never `admin`, so a
 * member cannot ship an app that fires an admin tool the first time an
 * admin runs it. Only an admin's accept with the declared tools reviewed
 * lifts it.
 *
 * `admin` is the owner broker's rule (declared, exists);
 * `team` is memberAppToolVerdict; `none` refuses every tool.
 */
import {
  appRunHolders,
  currentActor,
  gateCallRefusal,
  type AppAuthorLevel,
  type AppRunFor,
  type GateCaller,
  type Tool,
  type ViewerFor,
} from '@mantle/db';
import type { AccessLevel } from '@mantle/client-types';
import { getAppRuntime, type AppToolRules } from '@mantle/content';
import { resolveTool } from './resolve';
import { memberAppToolVerdict, type AppToolCheck } from './member-app-tools';
import { TEAM_APP_TOOLS_ALLOWED } from './runtime-policy';
import type { ToolHandlerContext } from './types';

/** The rules an app's tool call runs under. */
export type AppToolLevel = 'admin' | 'team' | 'none';

/** Who runs the app: the owner broker's admin or a member. */
export type AppToolRunner = 'admin' | 'team';

/** What the app's holders allow (`AppRuntime.toolRules`). */
export type AppHolding = AppToolRules;

/** `write`: an outside call that writes; the member
 *  broker logs its input. */
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
  if (holding === 'team') byHolders = 'team';
  else if (holding === 'admin') byHolders = runner;
  else byHolders = 'none';
  return byHolders === 'admin' && authorLevel === 'team' ? 'team' : byHolders;
}

const notDeclared = (slug: string) =>
  `This app isn't allowed to use the tool '${slug}'. It must be declared in the app's tools before it can run.`;

/** Why a run gets no tools (an app with no known holding). */
export const APP_NO_TOOLS = "This app can't use tools here.";

/** May a run at `level` of an app that declares `declared` call `slug`?
 *  `loginId`: who runs it, when known; a connector tool then also needs the
 *  login's workspace rule (loginConnectorRule), the same
 *  as the login's own MCP. `check.input`: the call's input, which names the
 *  Table a team app's row write changes (member-app-tools.ts rule 6). */
export async function appToolVerdict(
  level: AppToolLevel,
  ownerId: string,
  declared: readonly string[],
  slug: string,
  loginId?: string,
  check?: AppToolCheck,
): Promise<AppToolVerdict> {
  switch (level) {
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

/** The rules a broker judged an app's call at: a run's level, or a
 *  contact share's (contactAppToolVerdict). */
export type AppCallRules = AppToolLevel | 'contact';

/**
 * What a broker answers for an app's call its verdict refused:
 * a missing tool 404 before the gate (no row, no ref); every other refusal
 * is the one gate's (@mantle/db gateCallRefusal: the call's steps, nothing
 * run) on the call's `app-tool` ref, which carries the verdict: the
 * member-app narrower refuses it in the verdict's words, a 403
 * (member-app-tools.ts appToolGatePolicy, gate-narrowers.ts). The caller is
 * the broker's: the actor bound at its entry (currentActor()), via `app` or
 * `contact`, and the rules it judged at. The same status and body as the
 * verdict's, for every refusal (app-broker-parity.test.ts in server/web).
 *
 * It can throw, and a broker does not catch it, so the request answers
 * 500: gateCallRefusal throws GateNotReadyError while a
 * narrower or pre-run check is not registered (a process that did not load
 * @mantle/tools' gate-narrowers at boot), and any error that is not an
 * access refusal (a lost database connection under a step's read). Both
 * mean a misconfigured or failing process, never a caller's call: a
 * refusal is always answered, never thrown.
 */
export async function appToolRefusal(
  rules: AppCallRules,
  slug: string,
  verdict: { ok: false; status: 403 | 404; reason: string },
): Promise<{ status: number; error: string }> {
  if (verdict.status === 404) return { status: 404, error: verdict.reason };
  const caller: GateCaller = {
    actor: currentActor(),
    via: rules === 'contact' ? 'contact' : 'app',
    admin: null,
    facts: { appRules: rules },
  };
  const refusal = await gateCallRefusal(caller, { kind: 'app-tool', name: slug, verdict });
  // The verdict refused, so the gate does (the narrower reads its answer):
  // were it ever to let it through, the verdict's own answer still refuses.
  if (!refusal) return { status: verdict.status, error: verdict.reason };
  return { status: refusal.http?.status ?? verdict.status, error: refusal.toolText };
}

/**
 * Where an allowed call runs: the viewer scope, who it acts for and the
 * surface (a call at 'none' is never allowed, and throws). `admin` is the
 * owner's web surface (system work: only
 * an app the Admin workspace alone holds runs there); `team` is the member
 * broker's surface, naming the runner's login
 * (for an admin who runs a lower app, the admin's own login).
 *
 * `actsFor`: a run below admin reads
 * through the APP, not the runner's whole login: the app's holders beyond
 * Admin met with the runner's workspaces (AppRunFor in @mantle/db). So an
 * admin's run of a Team-held app never reads an Admin-only item, and a
 * member's run never reads the member's other workspaces.
 */
export function appToolScope(
  level: AppToolLevel,
  runner: { loginId: string; name: string },
  app: AppRunFor,
): {
  viewer: AccessLevel;
  actsFor: ViewerFor;
  surface: NonNullable<ToolHandlerContext['surface']>;
} {
  const actsFor: ViewerFor = { login: runner.loginId, app };
  switch (level) {
    case 'none':
      // appToolVerdict refuses every call at 'none', so nothing gets here.
      throw new Error(APP_NO_TOOLS);
    case 'admin':
      // With the runner's login: a tool that checks
      // the caller (a link) sees that login, never a surface with none.
      return { viewer: 'admin', actsFor, surface: { kind: 'web', loginId: runner.loginId } };
    case 'team':
      return {
        viewer: 'team',
        actsFor,
        surface: {
          kind: 'team',
          loginId: runner.loginId,
          contactName: runner.name,
          privateReads: false,
        },
      };
  }
}

/**
 * Whether an allowed call of an app run writes in the app's scope
 * (withViewer's `writes`): only a Table row write the policy
 * marks `table-rows` (isBuiltinTeamTableRowWrite), which the team rules let
 * through only on a Table homed in the holder of the app (member-app-tools.ts
 * rule 6). It writes as the running login in the app's scope, so the
 * database's checks decide (the item's Write switch, a Moderator of its
 * home, the actor and edit checks). Any other call, a read, another
 * built-in write an admin's run allows, or an outside tool (it writes
 * outside the brain, if at all), keeps the read-only scope.
 */
export async function appRunWrites(verdict: AppToolVerdict): Promise<boolean> {
  return (await appRunTableWrite(verdict)) !== null;
}

/** The argument an allowed call names its Table in when it is a Table
 *  write the policy marks `table-rows` (registry teamTableWriteArg:
 *  `table_id`, or `id` for table_commit), else null: appRunWrites' one
 *  reading, and what the broker's log row names (outsideCallLogDetail). */
export async function appRunTableWrite(verdict: AppToolVerdict): Promise<string | null> {
  if (!verdict.ok) return null;
  // A row with no handler (none should be) never writes.
  const h = verdict.tool.handler as Tool['handler'] | undefined;
  if (h?.kind !== 'builtin') return null;
  // Lazy: the registry imports every builtin, app_tools_set among them.
  const { teamTableWriteArg } = await import('./registry');
  return teamTableWriteArg(h.ref);
}

/** The largest input a team app's Table write takes, bytes: a few thousand
 *  rows a call, well under the broker's body ceiling; the draft's own
 *  ceiling is applyTableOps'. */
export const APP_TABLE_WRITE_MAX_BYTES = 1024 * 1024;

/**
 * For an app a workspace other than Admin holds: one warning per declared
 * tool its runs would refuse, in the broker's own words (the team rules run
 * for every runner), and one per row write it declares, saying the only
 * Tables it runs on (member-app-tools.ts rule 6: homed in the one workspace
 * beyond Admin that holds the app; none when no one or several hold it, as
 * the app's scope reads). An app the Admin workspace alone holds gets none,
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
    // Lazy: the registry imports every builtin, app_tools_set among them.
    const { isBuiltinTeamTableRowWrite } = await import('./registry');
    const warnings: string[] = [];
    /** How many live workspaces beyond Admin hold the app, once asked. */
    let holders: number | undefined;
    for (const slug of declared) {
      // No run here, so no runner login: the rules alone, against the
      // workspaces that hold this app (they read the built-in Team's until
      // 0286 made Team a normal workspace).
      const verdict = await appToolVerdict(level, ownerId, declared, slug, undefined, {
        rulesOnly: true,
        appId,
      });
      if (verdict.ok) {
        // A row write runs, but only on a Table homed in a workspace that
        // holds the app, for a user who may write it there (rule 6).
        const h = verdict.tool.handler;
        if (h.kind === 'builtin' && isBuiltinTeamTableRowWrite(h.ref)) {
          holders ??= (await appRunHolders({ id: appId })).length;
          warnings.push(
            holders === 1
              ? `The tool '${slug}' runs here only on a Table homed in the workspace that holds this app, as the user running it, who needs Write on that Table (or to be a Moderator of its workspace): on its own workspace's Tables the app does what that user may do there. Row changes land in the Table's draft; table_commit publishes it. Any other Table is refused: an app a workspace other than Admin holds runs the team rules.`
              : `The tool '${slug}' writes no Table here: a team app's row writes run only when exactly one workspace beyond Admin holds the app (${holders} do), on a Table homed in that workspace. Keep the app in one workspace (beside Admin) for its row writes to run.`,
          );
        }
        continue;
      }
      // What a team app may call, once (a write's refusal says it already).
      const allowed = verdict.reason.includes(TEAM_APP_TOOLS_ALLOWED)
        ? ''
        : ` ${TEAM_APP_TOOLS_ALLOWED}`;
      warnings.push(
        `${verdict.reason} Everyone running this app (admins too) gets an error: an app a workspace other than Admin holds runs the team rules.${allowed} Declare such a tool from an enabled team-level group instead (\`tool_group_list\` shows levels), have an admin open a connector to that workspace, switch External access on for an http tool that only reads, or keep the app in the Admin workspace only.`,
      );
    }
    return warnings;
  } catch {
    return [];
  }
}

/**
 * The tool warnings of apps a move filed into another folder: an app placed
 * in a folder takes its grants, and its holders set the rules its tools run
 * under, so moving an app changes which of its
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
