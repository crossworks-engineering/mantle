/**
 * The one app tool broker (A10 #9; docs/request-plumbing.md, "App tool
 * broker"): a running app's host.tools.call(), for every way an app runs.
 * Three routes take a call, and each is a config of runAppToolBroker:
 *
 *  - owner:   POST /api/apps/:id/tool-broker, an Admin user;
 *  - member:  the same route, a member login (lib/app-runner.ts
 *             memberToolBroker, workspaces W7e);
 *  - contact: POST /s/:token/tool-broker, a contact share past its code
 *             gate (an open link gets no tools: the route refuses it first).
 *
 * The route says who runs the app, how its body is read and how the app is
 * found; the broker does the rest, the same way for all three:
 *
 *  1. parse the body (one schema: the slug, the input and, for the owner's
 *     confirmation only, the host's ticket), read through the route's
 *     ceiling or the config's lower cap: 400 `invalid input`;
 *  2. find the app (the config's lookup): 404 `app not found`;
 *  3. the verdict (packages/tools app-tool-level.ts, external-access.ts):
 *     the owner's run at the level the app's holders and author allow
 *     (appToolLevel 'admin'), a member's at the team rules, a contact's by
 *     contactAppToolVerdict. A refused call answers the one gate's refusal
 *     (appToolRefusal);
 *  4. the owner's confirmation, at admin rules only: a tool that needs the
 *     owner's Yes answers 409 `reason: 'confirm'` with a ticket for that
 *     exact call, and runs once the host sends it back (apps audit S1). The
 *     member's and the contact's verdicts refuse such a tool outright;
 *  5. the dispatch, through the one gate as the app's broker
 *     (appBrokerCaller), in the run's scope: the owner's web as system work
 *     for an app the Admin workspace alone holds, else the app's scope for
 *     the runner (appToolScope), a link's served items for a contact;
 *  6. the answer: the tool's result as it is, `{ ok, output }` or
 *     `{ ok: false, error }`.
 *
 * What every call leaves, whoever runs it (the strongest of the three
 * before the fold): one Activity row per call that reached a verdict
 * (recordAppAccess, kind 'tool': the slug, an outside call's kind and a
 * write's input, or why it was refused), and an error row for every
 * refusal and every failed tool (recordAppError); a contact's call also
 * lands on the share's trail (recordShareAccess). Before the fold the
 * owner logged no refusal (and no call at admin rules) and the link logged
 * no error.
 *
 * Rate limits are the route rows' (lib/route-limits.ts memberToolBroker,
 * shareToolBroker): the gate takes them before the handler runs; nothing
 * here limits.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import { withViewer, type AppAuthorLevel, type ViewerFor } from '@mantle/db';
import {
  recordAppAccess,
  recordAppError,
  recordShareAccess,
  type AppToolRules,
} from '@mantle/content';
import {
  appBrokerCaller,
  appRunWrites,
  appToolLevel,
  appToolRefusal,
  appToolScope,
  appToolVerdict,
  contactAppToolVerdict,
  dispatchTool,
  outsideCallLogDetail,
  type AppCallRules,
  type AppToolVerdict,
  type ToolHandlerContext,
} from '@mantle/tools';
import {
  buildAppToolConfirmToken,
  verifyAppToolConfirmToken,
  type AppToolConfirmClaims,
} from '@/lib/auth';
import { readJson } from '@/lib/read-body';

/** The one body of an app's tool call. */
const AppToolBody = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
  /** The host's confirmation ticket for this exact call (never the app's);
   *  read on the owner's admin rules only. */
  confirmToken: z.string().max(4096).optional(),
});

/** The app as the broker reads it. The owner's run reads its holders' rules
 *  and its author (appToolLevel); the others do not. */
export type AppToolBrokerApp = {
  id: string;
  manifest: { toolSlugs?: readonly string[] | null };
  toolRules?: AppToolRules | null;
  authorLevel?: AppAuthorLevel;
};

/** Who runs the app: a login (the owner's or a member's), named on the
 *  team surface and in the log rows. */
export type AppToolRunner = { loginId: string; name: string };

/** A route's config of the broker. */
export type AppToolBrokerConfig =
  | (AppToolBrokerCommon & {
      /** An Admin user on the owner route. */
      via: 'owner';
      runner: AppToolRunner;
    })
  | (AppToolBrokerCommon & {
      /** A member login on the owner route. */
      via: 'member';
      runner: AppToolRunner;
      /** The bookkeeping the login's own scope cannot do, the verdict and
       *  the run around the app's scope: system work ('app-data'). */
      system: <T>(fn: () => Promise<T>) => Promise<T>;
    })
  | (AppToolBrokerCommon & {
      /** A contact on a share link, past its code gate. */
      via: 'contact';
      share: { id: string; contactId: string };
      /** The items the link serves: all a call of it reads. */
      served: () => Promise<readonly string[]>;
    });

type AppToolBrokerCommon = {
  /** The brain the app lives in. */
  ownerId: string;
  /** A cap on the body below the route's ceiling (bytes). */
  maxBytes?: number;
  /** The app this caller may run, null (the one 404) or the route's own
   *  answer. */
  app: () => Promise<AppToolBrokerApp | Response | null>;
};

type Verdict = AppToolVerdict;
type Allowed = Extract<Verdict, { ok: true }>;
type Surface = NonNullable<ToolHandlerContext['surface']>;

/** How one call is judged and where it runs, by who runs it. */
type Run = {
  rules: AppCallRules;
  verdict: () => Promise<Verdict>;
  /** The owner's confirmation applies (admin rules). */
  confirm: boolean;
  surface: Surface;
  /** The viewer scope the dispatch runs in, read once the call is
   *  allowed; null: as is (system work). */
  actsFor: () => Promise<ViewerFor | null>;
};

function runOf(
  config: AppToolBrokerConfig,
  app: AppToolBrokerApp,
  slug: string,
  input: Readonly<Record<string, unknown>>,
): Run {
  const declared = app.manifest.toolSlugs ?? [];
  if (config.via === 'contact') {
    const { share, served } = config;
    return {
      rules: 'contact',
      verdict: () => contactAppToolVerdict(config.ownerId, declared, slug),
      confirm: false,
      surface: { kind: 'contact', contactId: share.contactId, shareId: share.id },
      // A link reads no workspace, only what it serves (plan 8.1, R6),
      // never a snapshot copy (W6b fix round 3, L-1).
      actsFor: async () => ({ link: { served: [...(await served())] } }),
    };
  }
  // The owner's run: the rules the app's holders and its author allow (a
  // member-built app, or one a workspace other than Admin holds, runs the
  // team rules for an admin too, plan R2). A member's run: the team rules,
  // whatever the app's author (R2).
  const level =
    config.via === 'owner'
      ? appToolLevel('admin', app.toolRules, app.authorLevel)
      : appToolLevel('team', 'team', 'admin');
  // A member's login: a connector tool also needs the login's workspace
  // rule, and every workspace that holds the app must hold the connector.
  // The admin's own rule applies to an admin-level run; a team-level one
  // keeps the Team rule, so the admin's own connectors never lift an
  // author-limited app above what it runs with for its members.
  const loginId = config.via === 'member' || level !== 'team' ? config.runner.loginId : undefined;
  // The call's input names the Table a team app's row write changes
  // (member-app-tools.ts rule 6: only one homed in a holder of the app).
  const check = config.via === 'member' || level !== 'admin' ? { appId: app.id, input } : undefined;
  const scope = level === 'none' ? null : appToolScope(level, config.runner, { id: app.id });
  return {
    rules: level,
    verdict: () => appToolVerdict(level, config.ownerId, declared, slug, loginId, check),
    confirm: config.via === 'owner' && level === 'admin',
    // appToolVerdict refuses every call at 'none', so no scope is needed.
    surface: scope?.surface ?? { kind: 'web' },
    // An app the Admin workspace alone holds runs as the owner's web
    // surface (system work); any other in the app's scope (AppRunFor).
    actsFor: async () => (!scope || scope.viewer === 'admin' ? null : scope.actsFor),
  };
}

/** The log rows' caller columns: the login, or the share and its contact. */
function whoOf(
  config: AppToolBrokerConfig,
): { actorId: string } | { shareId: string; contactId: string } {
  return config.via === 'contact'
    ? { shareId: config.share.id, contactId: config.share.contactId }
    : { actorId: config.runner.loginId };
}

/** The confirmation ticket's claims: this owner, login, app, tool, input. */
function confirmClaims(
  config: AppToolBrokerConfig & { via: 'owner' },
  app: AppToolBrokerApp,
  tool: Allowed['tool'],
  input: unknown,
): AppToolConfirmClaims {
  return {
    ownerId: config.ownerId,
    actorId: config.runner.loginId,
    appId: app.id,
    slug: tool.slug,
    inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  };
}

/** One app tool call, as `config` says who runs it. */
export async function runAppToolBroker(
  req: Request,
  config: AppToolBrokerConfig,
): Promise<Response> {
  const parsed = AppToolBody.safeParse(
    (await readJson(req, {
      empty: null,
      ...(config.maxBytes ? { maxBytes: config.maxBytes } : {}),
    })) ?? {},
  );
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });
  }
  const found = await config.app();
  if (found instanceof Response) return found;
  if (!found) return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  const app = found;
  const { slug, input, confirmToken } = parsed.data;
  const system = config.via === 'member' ? config.system : <T>(fn: () => Promise<T>) => fn();

  const run = runOf(config, app, slug, input);
  const verdict = await system(run.verdict);
  const who = whoOf(config);
  const via = config.via;
  const tagged = { via, ...('contactId' in who ? { contactId: who.contactId } : {}), slug };
  // The call's Activity row, and a contact's on the share's own trail
  // (refused calls included).
  const logCall = (detail: Record<string, unknown>, allowed: boolean) => {
    recordAppAccess({ ownerId: config.ownerId, appNodeId: app.id, ...who, kind: 'tool', detail });
    if ('shareId' in who) {
      recordShareAccess({
        ownerId: config.ownerId,
        shareId: who.shareId,
        contactId: who.contactId,
        kind: allowed ? 'tool' : 'refused',
        detail: allowed ? { slug } : { slug, refused: 'tools' },
      });
    }
  };
  const logError = (message: string, status: number) =>
    recordAppError({
      ownerId: config.ownerId,
      appNodeId: app.id,
      ...who,
      source: 'tool',
      via,
      slug,
      message,
      status,
    });

  if (!verdict.ok) {
    logCall({ ...tagged, refused: verdict.reason }, false);
    logError(verdict.reason, verdict.status);
    // A missing tool 404; every other refusal the gate's 403, in the
    // verdict's words (A5 step 3b).
    const refused = await appToolRefusal(run.rules, slug, verdict);
    return NextResponse.json({ ok: false, error: refused.error }, { status: refused.status });
  }

  if (run.confirm && config.via === 'owner' && verdict.tool.requiresConfirm) {
    // The app never sees the ticket: the host builds the request body from
    // the slug and the input only, so app code cannot confirm for the owner.
    const claims = confirmClaims(config, app, verdict.tool, input);
    if (!confirmToken) {
      return NextResponse.json(
        {
          ok: false,
          reason: 'confirm',
          error: `The tool '${verdict.tool.slug}' needs your confirmation before it runs.`,
          confirm: {
            token: buildAppToolConfirmToken(claims),
            slug: verdict.tool.slug,
            name: verdict.tool.name,
            description: verdict.tool.description,
          },
        },
        { status: 409 },
      );
    }
    if (!verifyAppToolConfirmToken(confirmToken, claims)) {
      const why = 'the confirmation expired or did not match the call';
      logCall({ ...tagged, refused: why }, false);
      logError(why, 403);
      return NextResponse.json(
        {
          ok: false,
          error: `The confirmation for '${verdict.tool.slug}' expired or does not match this call. Run it again.`,
        },
        { status: 403 },
      );
    }
  }

  // An outside call names its kind, so the log shows which calls reached
  // outside the brain; a write keeps its input too (M2 audit, low 4).
  logCall({ ...tagged, ...outsideCallLogDetail(verdict, input) }, true);
  // Through the one gate as the app's broker (A5 step 3b).
  const dispatch = () =>
    dispatchTool(verdict.tool, input, {
      ownerId: config.ownerId,
      surface: run.surface,
      caller: appBrokerCaller(run.surface, verdict),
    });
  const scope = { actsFor: await run.actsFor() };
  // A built-in write the team rules allowed (a Table row write) runs in the
  // app's scope as a write, as the running login (appRunWrites); a read
  // keeps the read-only scope.
  const writes = scope.actsFor !== null && (await appRunWrites(verdict));
  const result = await system(() =>
    scope.actsFor ? withViewer(scope.actsFor, dispatch, { writes }) : dispatch(),
  );
  if (!result.ok) logError(result.error, 200);
  return NextResponse.json(result);
}
