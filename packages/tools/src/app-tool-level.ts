/**
 * The ONE rule for the level an app's tools run at (client tier audit
 * 2026-09-30, L1): the LOWER of the runner's level and the app's level. The
 * three app tool brokers (owner, member, client) and the author warnings all
 * ask here, so they cannot drift.
 *
 * Why: an app's database is shared by everyone who runs the app. A tool that
 * reads above the app's level would let a run copy team or admin data into
 * a database that readers at the app's level query with any SQL (every
 * client, for a client-level app). So a client-level app gets the client
 * rules for every runner, an admin's and a member's run included, and a
 * public-level app gets no tools at all, as on its share link.
 *
 *   runner \ app   admin    team     client   public
 *   admin          admin    team     client   none
 *   member         (never)  team     client   none
 *   client         (never)  (never)  client   (never)
 *
 * `admin` is the owner broker's rule as it always was (declared, exists);
 * `team` is memberAppToolVerdict; `client` is clientAppToolVerdict; `none`
 * refuses every tool.
 */
import { asViewerLevel, lowerLevel, type Tool, type ViewerLevel } from '@mantle/db';
import { getApp } from '@mantle/content';
import { resolveTool } from './resolve';
import { memberAppToolVerdict } from './member-app-tools';
import { CLIENT_APP_TOOL_SLUGS, clientAppToolVerdict } from './client-app-tools';
import type { ToolHandlerContext } from './types';

/** The rules an app's tool call runs under. */
export type AppToolLevel = 'admin' | 'team' | 'client' | 'none';

/** Who runs the app: the owner broker's admin, a member or a client. */
export type AppToolRunner = 'admin' | 'team' | 'client';

export type AppToolVerdict =
  { ok: true; tool: Tool } | { ok: false; status: 403 | 404; reason: string };

/** The lower of the runner's level and the app's level. A public app, and a
 *  pair with no common level (client with public), run no tools. */
export function appToolLevel(runner: AppToolRunner, appLevel: unknown): AppToolLevel {
  let level: ViewerLevel;
  try {
    level = lowerLevel(runner, asViewerLevel(appLevel));
  } catch {
    return 'none';
  }
  return level === 'public' ? 'none' : level;
}

const notDeclared = (slug: string) =>
  `This app isn't allowed to use the tool '${slug}'. It must be declared in the app's tools before it can run.`;

/** Why a public-level app runs no tools: its share link gets none. */
export const PUBLIC_APP_NO_TOOLS =
  "This app is at public level, so it can't use tools: anyone with its link runs it, and a link gets only the app's own data.";

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
      return { ok: false, status: 403, reason: PUBLIC_APP_NO_TOOLS };
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
      throw new Error(PUBLIC_APP_NO_TOOLS);
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
 * declared tool its runs would refuse, in the broker's own words. The rules
 * are the app's level (appToolLevel with an admin runner): a team app warns
 * about what members are refused, a client app about what the client rules
 * refuse (every run, an admin's too), a public app about every tool. An
 * admin-level app gets none. Given back by every author move that can
 * change the answer: `app_tools_set`, `app_publish` and setting an app's
 * level (`access_set`). Best-effort: a failed check warns nothing and never
 * fails the move it rides on.
 */
export async function appToolWarnings(ownerId: string, appId: string): Promise<string[]> {
  try {
    const app = await getApp(ownerId, appId);
    if (!app) return [];
    const level = appToolLevel('admin', app.audience);
    if (level === 'admin') return [];
    const declared = [...new Set(app.manifest.toolSlugs ?? [])];
    const warnings: string[] = [];
    for (const slug of declared) {
      const verdict = await appToolVerdict(level, ownerId, declared, slug);
      if (verdict.ok) continue;
      if (level === 'team') {
        warnings.push(
          `${verdict.reason} Members running this app get an error: declare a read-only built-in tool from an enabled team-level group instead (\`tool_group_list\` shows levels), or keep the app at admin level.`,
        );
      } else if (level === 'client') {
        warnings.push(
          `${verdict.reason} Everyone running this app (admins and members too) gets an error: a client-level app uses the client rules, so it can call only the client tools (${CLIENT_APP_TOOL_SLUGS.join(', ')}) from an enabled client-level group. Raise the app to team level to use other tools.`,
        );
      } else {
        warnings.push(
          `The tool '${slug}' won't run: ${PUBLIC_APP_NO_TOOLS} Remove it, or raise the app to client level or above.`,
        );
      }
    }
    return warnings;
  } catch {
    return [];
  }
}
