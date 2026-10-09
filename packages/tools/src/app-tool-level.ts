/**
 * The ONE rule for the level an app's tools run at (client tier audit
 * 2026-09-30, L1). The three app tool brokers (owner, member, client) and the
 * author warnings all ask here, so they cannot drift.
 *
 * Why: an app's database is shared by everyone who runs the app, and every
 * client reads a client-level app's database with any SQL. A tool that reads
 * above client level would let a member's or an admin's run copy team or
 * admin data into it. So a client-level app gets the client rules for EVERY
 * runner, an admin's and a member's run included (Jason, 2026-09-30). Every
 * other app keeps the runner's own rules, as before: a team app's members
 * write only what members can read, and an admin's run of a team or public
 * app keeps the admin's tools (team apps on real boxes call MCP and recipe
 * tools from an admin's run).
 *
 *   runner \ app   admin    team     client   public
 *   admin          admin    admin    client   admin
 *   member         (never)  team     client   team
 *   client         (never)  (never)  client   (never)
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
import { asViewerLevel, type AppAuthorLevel, type Tool, type ViewerLevel } from '@mantle/db';
import { getAppRuntime } from '@mantle/content';
import { resolveTool } from './resolve';
import { memberAppToolVerdict } from './member-app-tools';
import { CLIENT_APP_TOOL_SLUGS, clientAppToolVerdict } from './client-app-tools';
import type { ToolHandlerContext } from './types';

/** The rules an app's tool call runs under. */
export type AppToolLevel = 'admin' | 'team' | 'client' | 'none';

/** Who runs the app: the owner broker's admin, a member or a client. */
export type AppToolRunner = 'admin' | 'team' | 'client';

/** `write`: an outside call that writes (team apps Phase 2); the member
 *  and client brokers log its input. */
export type AppToolVerdict =
  { ok: true; tool: Tool; write?: boolean } | { ok: false; status: 403 | 404; reason: string };

/** A client-level app runs the client rules for every runner; any other app
 *  runs the runner's own rules. A client never runs a non-client app (its
 *  broker 404s first), so that pair runs no tools. Then the author ceiling:
 *  a member-built app (`authorLevel` 'team') never runs at admin rules. */
export function appToolLevel(
  runner: AppToolRunner,
  appLevel: unknown,
  authorLevel: AppAuthorLevel = 'admin',
): AppToolLevel {
  let level: ViewerLevel;
  try {
    level = asViewerLevel(appLevel);
  } catch {
    return 'none';
  }
  const byRunner: AppToolLevel =
    level === 'client' ? 'client' : runner === 'client' ? 'none' : runner;
  return byRunner === 'admin' && authorLevel === 'team' ? 'team' : byRunner;
}

const notDeclared = (slug: string) =>
  `This app isn't allowed to use the tool '${slug}'. It must be declared in the app's tools before it can run.`;

/** Why a run gets no tools (a client run of a non-client app, never reached). */
export const APP_NO_TOOLS = "This app can't use tools here.";

/** May a run at `level` of an app that declares `declared` call `slug`? */
export async function appToolVerdict(
  level: AppToolLevel,
  ownerId: string,
  declared: readonly string[],
  slug: string,
): Promise<AppToolVerdict> {
  switch (level) {
    case 'client':
      return clientAppToolVerdict(ownerId, declared, slug);
    case 'team':
      return memberAppToolVerdict(ownerId, declared, slug);
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
 * For an app anyone below admin runs (team level or lower): one warning per
 * declared tool its runs would refuse, in the broker's own words. A client
 * app warns about what the client rules refuse (every run, an admin's too);
 * a team or public app about what members are refused. An admin-level app
 * gets none. Given back by every author move that can change the answer:
 * `app_tools_set`, `app_publish`, setting an app's level (`access_set`) and
 * moving it into another folder (`movedAppToolWarnings`).
 * Best-effort: a failed check warns nothing and never fails the move it
 * rides on.
 */
export async function appToolWarnings(ownerId: string, appId: string): Promise<string[]> {
  try {
    const app = await getAppRuntime(ownerId, appId);
    if (!app) return [];
    // The level it is used at, folder shares included (access matrix M5).
    const audience = app.effectiveAudience;
    const level = appToolLevel('team', audience);
    // An admin-level app warns only when a member built it: the author
    // ceiling runs it at team rules for its admins too (Phase 3).
    const capped = audience === 'admin' && app.authorLevel === 'team';
    if ((audience === 'admin' && !capped) || level === 'none') return [];
    const declared = [...new Set(app.manifest.toolSlugs ?? [])];
    const warnings: string[] = [];
    for (const slug of declared) {
      const verdict = await appToolVerdict(level, ownerId, declared, slug);
      if (verdict.ok) continue;
      if (level === 'client') {
        warnings.push(
          `${verdict.reason} Everyone running this app (admins and members too) gets an error: a client-level app uses the client rules, so it can call only the client tools (${CLIENT_APP_TOOL_SLUGS.join(', ')}) from an enabled client-level group, a connector tool whose connector is at client level, or an http tool an admin switched External access on for. Raise the app to team level to use other built-in tools.`,
        );
      } else {
        warnings.push(
          `${verdict.reason} Members running this app get an error: declare a read-only built-in tool from an enabled team-level group instead (\`tool_group_list\` shows levels), have an admin set a connector's level to team or lower for its tools, switch External access on for an http tool that only reads, or keep the app at admin level.`,
        );
      }
    }
    return warnings;
  } catch {
    return [];
  }
}

/**
 * The tool warnings of apps a move filed into another folder (access matrix
 * N11): a folder shared with clients sets the level an app is used at
 * (M5), so moving an app in or out changes which of its declared tools
 * run, for its admins too. Each warning names its app when more than one
 * moved. Best-effort, as appToolWarnings.
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
