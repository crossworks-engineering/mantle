/**
 * The one app tool broker (docs/request-plumbing.md, "App tool broker"):
 * a running app's host.tools.call(), for every way an app runs. Three
 * routes take a call, and each is a config of runAppToolBroker:
 *
 *  - owner:   POST /api/apps/:id/tool-broker, an Admin user;
 *  - member:  the same route, a member login (lib/app-runner.ts
 *             memberToolBroker);
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
 *     exact call, and runs once the host sends it back. The
 *     member's and the contact's verdicts refuse such a tool outright;
 *  5. the dispatch, through the one gate as the app's broker
 *     (appBrokerCaller), in the run's scope: the owner's web as system work
 *     for an app the Admin workspace alone holds, else the runner's own
 *     rights, as by hand (appToolScope), a link's served items for a
 *     contact;
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
import {
  appRunWriter,
  createHomeIntent,
  withCreateHome,
  withViewer,
  type AppAuthorLevel,
} from '@mantle/db';
import {
  recordAppAccess,
  recordAppError,
  recordShareAccess,
  type AppToolRules,
} from '@mantle/content';
import {
  APP_FILE_WRITE_MAX_BYTES,
  APP_TABLE_WRITE_MAX_BYTES,
  appBrokerCaller,
  appRunFileSave,
  appRunFileWrite,
  appCallMayCarryFile,
  appRunTableWrite,
  appToolRefusal,
  appToolRunPlan,
  dispatchTool,
  outsideCallLogDetail,
  type AppToolRunPlan,
  type AppToolVerdict,
} from '@mantle/tools';
import {
  buildAppToolConfirmToken,
  verifyAppToolConfirmToken,
  type AppToolConfirmClaims,
} from '@/lib/auth';
import { readJsonSized } from '@/lib/read-body';
import { bodyTooLargeResponse } from '@/lib/body-limit';

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
       *  the run around the app run's scope: system work ('app-data'). */
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
  /** A larger cap a team app's file write may carry (a 16 MB file as
   *  base64): the body is read up to it, and a call over `maxBytes` that is
   *  not a file write answers the one 413 of `maxBytes`, as it did. */
  fileMaxBytes?: number;
  /** The app this caller may run, null (the one 404) or the route's own
   *  answer. */
  app: () => Promise<AppToolBrokerApp | Response | null>;
};

type Verdict = AppToolVerdict;
type Allowed = Extract<Verdict, { ok: true }>;

/** How one call is judged and where it runs, by who runs it: the one plan
 *  the app timers take too (@mantle/tools app-tool-run.ts appToolRunPlan),
 *  at admin rules in the caller's own request scope. */
function runOf(
  config: AppToolBrokerConfig,
  app: AppToolBrokerApp,
  slug: string,
  input: Readonly<Record<string, unknown>>,
): AppToolRunPlan {
  return appToolRunPlan(
    config.via === 'contact'
      ? { via: 'contact', ownerId: config.ownerId, share: config.share, served: config.served }
      : { via: config.via, ownerId: config.ownerId, runner: config.runner, adminScope: 'caller' },
    app,
    slug,
    input,
  );
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
  const cap = config.fileMaxBytes ?? config.maxBytes;
  const body = await readJsonSized(req, { empty: null, ...(cap ? { maxBytes: cap } : {}) });
  const parsed = AppToolBody.safeParse(body.value ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });
  }
  const system = config.via === 'member' ? config.system : <T>(fn: () => Promise<T>) => fn();
  // Past `maxBytes`, only a file write's call goes on (its verdict still
  // judges it); any other answers as the cap always did.
  if (
    config.fileMaxBytes &&
    config.maxBytes &&
    body.bytes > config.maxBytes &&
    !(await system(() => appCallMayCarryFile(config.ownerId, parsed.data.slug)))
  ) {
    return bodyTooLargeResponse(config.maxBytes);
  }
  const found = await config.app();
  if (found instanceof Response) return found;
  if (!found) return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  const app = found;
  const { slug, input, confirmToken } = parsed.data;
  // Who a team app's Table or file write would run as: read here, in the request,
  // before `system` masks its scope and actor (a mutating request of this
  // login, never a read-only login; withViewer checks it again).
  const writer = config.via === 'contact' ? null : appRunWriter();

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
    // verdict's words.
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

  // A Table write the team rules allowed (a row write or table_commit):
  // the argument naming its Table.
  const tableArg = await appRunTableWrite(verdict);
  // A documents tool that saves its file (no `bytes: true`).
  const fileSave = await appRunFileSave(verdict, input);
  // A file write the team rules allowed (file_upload, file_move,
  // file_rename).
  const fileWrite = await appRunFileWrite(verdict);
  const scope = { actsFor: await run.actsFor() };
  // It runs as a write, as the running login in that login's own scope
  // (wherever that user may write by hand), only for a login that may
  // write in this request (appRunWriter); a read keeps the read-only
  // scope. A documents save with no writer runs read-only, and the tool
  // answers why it saved nothing (teamAppSaveRefusal).
  const writes = scope.actsFor !== null && (tableArg !== null || fileSave || fileWrite);
  const writeRefusal = !(writes && (tableArg !== null || fileWrite))
    ? null
    : !writer
      ? `This run cannot change data: a team app writes ${fileWrite ? 'a file' : 'a Table'} only in a request that may write, as a login that writes (not a read-only key).`
      : fileWrite
        ? fileWriteSizeRefusal(input)
        : Buffer.byteLength(JSON.stringify(input)) > APP_TABLE_WRITE_MAX_BYTES
          ? `The call is larger than ${APP_TABLE_WRITE_MAX_BYTES / (1024 * 1024)} MB, the most a team app's Table write takes. Split the rows into smaller calls.`
          : null;
  if (writeRefusal) {
    logCall({ ...tagged, refused: writeRefusal }, false);
    logError(writeRefusal, 403);
    return NextResponse.json({ ok: false, error: writeRefusal }, { status: 403 });
  }
  // A documents save lands where the runner's own create lands: the one
  // create-home rule (@mantle/db createHomeIntent), asked here, in the
  // request, as the runner (a workspace they moderate when named, else
  // their private one, made now; an Admin user's, by the folder). The app
  // run's own scope carries no create home of its own.
  const saveHome =
    writes && writer && fileSave
      ? await createHomeIntent(writer.loginId, null, { ownWork: 'auto', makePrivate: true })
      : null;
  if (saveHome && 'refused' in saveHome) {
    logCall({ ...tagged, refused: saveHome.message }, false);
    logError(saveHome.message, 403);
    return NextResponse.json({ ok: false, error: saveHome.message }, { status: 403 });
  }
  // An outside call names its kind, so the log shows which calls reached
  // outside the brain; a write keeps its input too; a
  // Table write names its Table and its row count. A file write's row is
  // written once it ran (below), with what it did.
  if (!fileWrite) {
    logCall(
      {
        ...tagged,
        ...outsideCallLogDetail(verdict, input, tableArg),
        // Asked for: the tool itself refuses a save it may not make.
        ...(fileSave && scope.actsFor ? { write: true, save_asked: 'file' } : {}),
      },
      true,
    );
  }
  // Through the one gate as the app's broker.
  const dispatch = () =>
    dispatchTool(verdict.tool, input, {
      ownerId: config.ownerId,
      surface: run.surface,
      caller: appBrokerCaller(run.surface, verdict),
    });
  let result: Awaited<ReturnType<typeof dispatchTool>> | undefined;
  try {
    const go = () =>
      system(() =>
        scope.actsFor
          ? withViewer(scope.actsFor, dispatch, writes && writer ? { writes: writer } : {})
          : dispatch(),
      );
    result = await (saveHome ? withCreateHome(saveHome, go) : go());
  } finally {
    // A file write's row names its folder and its file, and whether it
    // landed (a refusal where it ran, or a throw, is no write).
    if (fileWrite) logCall({ ...tagged, ...fileWriteLogDetail(input, result) }, true);
  }
  if (!result.ok) {
    logError(result.error, 200);
    return NextResponse.json(result);
  }
  // A picture for a model: the app's kit reads `output` alone, so it would
  // cross the bridge for nothing.
  const { modelImages: _forAModel, ...forTheApp } = result;
  return NextResponse.json(forTheApp);
}

/** The decoded bytes a file write's call carries (file_upload's
 *  `content_text` as utf-8, or `content_base64`), 0 for a move or a rename. */
function fileWriteBytes(input: Readonly<Record<string, unknown>>): number {
  if (typeof input.content_text === 'string') return Buffer.byteLength(input.content_text, 'utf8');
  if (typeof input.content_base64 === 'string') {
    return Buffer.byteLength(input.content_base64, 'base64');
  }
  return 0;
}

/** Why a team app's file write is too large, or null: its file's decoded
 *  bytes, at most APP_FILE_WRITE_MAX_BYTES a call (the owner's 16 MB). */
function fileWriteSizeRefusal(input: Readonly<Record<string, unknown>>): string | null {
  // Counted only as strings: anything else is no file's bytes.
  for (const k of ['content_text', 'content_base64'] as const) {
    if (input[k] != null && typeof input[k] !== 'string') return `${k} must be a string.`;
  }
  const bytes = fileWriteBytes(input);
  if (bytes <= APP_FILE_WRITE_MAX_BYTES) return null;
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `The file is ${mb(bytes)} MB, past the ${mb(APP_FILE_WRITE_MAX_BYTES)} MB a team app uploads in one call. Upload a larger file through Files instead.`;
}

/** A file write's Activity row: the folder and the file it names, never
 *  its bytes, and once it ran, whether it landed and the file it landed
 *  as (its id, folder and name: a rename's folder, an overwrite's id). */
function fileWriteLogDetail(
  input: Readonly<Record<string, unknown>>,
  result: { ok: boolean; output?: unknown } | undefined,
): Record<string, unknown> {
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
  const row = (result?.ok ? result.output : null) as Record<string, unknown> | null;
  const folder =
    text(row?.parentPath, 500) ?? text(input.parent_path, 500) ?? text(input.dest_path, 500);
  const fileId = text(row?.id, 64) ?? text(input.file_id, 64);
  const filename = text(row?.filename, 200) ?? text(input.filename, 200);
  const bytes = fileWriteBytes(input);
  return {
    write: result?.ok === true,
    ...(result?.ok === true ? {} : { landed: false }),
    file: {
      ...(folder !== null ? { folder } : {}),
      ...(filename !== null ? { filename } : {}),
      ...(fileId !== null ? { file_id: fileId } : {}),
      ...(typeof input.new_stem === 'string' ? { new_name: text(input.new_stem, 200) } : {}),
      ...(input.overwrite === true ? { overwrite: true } : {}),
      ...(bytes > 0 ? { bytes } : {}),
    },
  };
}
