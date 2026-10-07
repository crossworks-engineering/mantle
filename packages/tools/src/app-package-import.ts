/**
 * Import a `.mantleapp` package as a NEW app (apps first-class plan, Phase 3;
 * the format is @mantle/content/app-package's). Everything is checked before
 * anything is written: the package, its schema (on an empty trial database
 * when it brings no data) and its database (quick_check, then a clean copy).
 *
 * Then: the app is made from the PUBLISHED code, built here (builds do not
 * travel between brains) and published when it was published where it came
 * from; the draft goes back on top as the draft, with a preview build.
 *
 * The app gets NO tools. A package is a file from anywhere: its declared
 * tools (access_set, web_fetch, app_source_set ...) would run as the owner
 * the moment the published app opens. So the allowlist starts empty, and
 * the declared tools come back as `requestedToolSlugs` (this brain has them;
 * the owner grants them with app_tools_set after a look at the code) and
 * `droppedToolSlugs` (this brain does not have them).
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  NoGreenBuildError,
  notifyAppNavChanged,
  publishApp,
  saveDraftSource,
  type AppHistoryActor,
} from '@mantle/content';
import { checkAppSchemaScript, checkAppSchemaScriptOnFile } from '@mantle/content/app-broker';
import {
  AppPackageError,
  dropUnfinishedApp,
  installAppPackage,
  openAppPackage,
} from '@mantle/content/app-package';
import { errorMessage } from '@mantle/std';
import { recordIngest } from '@mantle/tracing';
import { buildAndStageApp, type AppBuildOutcome } from './app-build-stage';
import { resolveTool } from './resolve';

export type AppPackageImportResult = {
  appId: string;
  title: string;
  /** Live now (it was published where it came from, and built green here). */
  published: boolean;
  /** The last build: of the published code, or of the draft when it has one. */
  build: AppBuildOutcome | null;
  /** The bytes of data it came with, or null when it brought none. */
  dataBytes: number | null;
  /** Declared tools this brain has. NOT granted: the owner grants them with
   *  app_tools_set after reading the code. */
  requestedToolSlugs: string[];
  /** Declared tools this brain does not have. */
  droppedToolSlugs: string[];
  hasDraft: boolean;
};

export async function importAppPackage(
  ownerId: string,
  bytes: Buffer | Uint8Array,
  opts: { title?: string; withData?: boolean; actor?: AppHistoryActor } = {},
): Promise<AppPackageImportResult> {
  const opened = await openAppPackage(bytes);
  const { pkg } = opened;

  // ── check everything before anything is written ──
  const requestedToolSlugs: string[] = [];
  const droppedToolSlugs: string[] = [];
  for (const slug of new Set(pkg.manifest.toolSlugs ?? [])) {
    if (await resolveTool(ownerId, slug)) requestedToolSlugs.push(slug);
    else droppedToolSlugs.push(slug);
  }
  const withData = opts.withData !== false && pkg.data !== null;
  const schemaSql = pkg.manifest.sqlite?.schemaSql.trim() ? pkg.manifest.sqlite.schemaSql : null;
  if (schemaSql && !withData) {
    try {
      // A new app's database is tried empty (its id is only a file name).
      await checkAppSchemaScript(ownerId, randomUUID(), schemaSql);
    } catch (err) {
      throw new AppPackageError(`the app's schema does not run: ${errorMessage(err)}`);
    }
  }
  const data = withData ? await opened.extractData() : null;

  try {
    // The declared schema runs over the data it came with when it is newer
    // (the first statement applies it): it must run there, or the new app
    // could not open its own data (apps audit 2026-10-02, low).
    const declared = pkg.manifest.sqlite?.schemaVersion ?? 0;
    if (schemaSql && data && declared > data.schemaVersion) {
      try {
        await checkAppSchemaScriptOnFile(data.path, schemaSql);
      } catch (err) {
        throw new AppPackageError(
          `the app's schema does not run over the data it came with: ${errorMessage(err)}`,
        );
      }
    }
    const app = await installAppPackage(ownerId, pkg, {
      ...(opts.title ? { title: opts.title } : {}),
      toolSlugs: [],
      data,
    });
    try {
      return await finishImport(ownerId, app, pkg, opts, data, {
        requestedToolSlugs,
        droppedToolSlugs,
      });
    } catch (err) {
      // A bad file makes nothing: not half an app either.
      await dropUnfinishedApp(ownerId, app.id);
      throw err;
    }
  } finally {
    if (data) await rm(data.path, { force: true });
  }
}

/** After the install: build, publish when it was published, the draft. */
async function finishImport(
  ownerId: string,
  app: { id: string; title: string },
  pkg: Awaited<ReturnType<typeof openAppPackage>>['pkg'],
  opts: { actor?: AppHistoryActor },
  data: { path: string } | null,
  tools: { requestedToolSlugs: string[]; droppedToolSlugs: string[] },
): Promise<AppPackageImportResult> {
  // ── the published code: build here, publish when it was published ──
  let build: AppBuildOutcome | null = null;
  let published = false;
  if (pkg.code.published) {
    build = await buildAndStageApp(ownerId, app.id);
    if (build?.buildOk) {
      try {
        await publishApp(ownerId, app.id, { note: 'imported', actor: opts.actor ?? 'owner' });
        published = true;
      } catch (err) {
        if (!(err instanceof NoGreenBuildError)) throw err;
      }
    }
  }
  // ── the draft back on top, with a preview build ──
  if (pkg.code.draft) {
    await saveDraftSource(ownerId, app.id, pkg.code.draft);
    build = await buildAndStageApp(ownerId, app.id);
  } else if (!pkg.code.published) {
    build = await buildAndStageApp(ownerId, app.id);
  }
  void recordIngest({
    source: 'page_create',
    ownerId,
    nodeId: app.id,
    summary: `App imported: ${app.title.slice(0, 80)}`,
    payload: { title: app.title, via: 'package', kind: 'app' },
    snippet: app.title,
  });
  void notifyAppNavChanged(ownerId);
  return {
    appId: app.id,
    title: app.title,
    published,
    build,
    dataBytes: data ? (pkg.data?.bytes ?? null) : null,
    ...tools,
    hasDraft: pkg.code.draft !== null,
  };
}
