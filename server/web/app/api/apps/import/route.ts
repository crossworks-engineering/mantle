/**
 * POST /api/apps/import — create-or-update a whole mini-app in one call, then
 * (by default) build it and optionally publish. This is the atomic "upload an
 * app I authored elsewhere" endpoint: pass the full source tree at once instead
 * of the per-file draft autosave, plus optional tool-allowlist + SQLite schema.
 *
 * Session-authed like the other /api/apps routes (getOwnerOr401). For an
 * unauthenticated/headless push on a single-user box use `pnpm apps:push`, which
 * talks to the content layer directly (owner resolved at boot).
 *
 * Everything is checked BEFORE anything is written (apps audit G6): the tool
 * slugs, and the schema on a trial copy of the database. A bad slug or schema
 * used to leave a half-made app behind. The name and dress fields follow the
 * create route's rules (lib/app-meta.ts). An update first takes a snapshot of
 * the app (`pre_import`: the code, and the data when the import brings a
 * schema), so an import over a working app can be undone.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { AppMetaFields } from '@/lib/app-meta';
import {
  createApp,
  saveDraftSource,
  getAppRuntime,
  setManifest,
  declareAppSchema,
  publishApp,
  notifyAppNavChanged,
  AppSourceLimitError,
  NoGreenBuildError,
  MAX_APP_FILES,
  MAX_APP_FILE_BYTES,
  MAX_APP_PATH_LEN,
} from '@mantle/content';
import { checkAppSchemaScript } from '@mantle/content/app-broker';
import { createAppSnapshot } from '@mantle/content/app-snapshots';
import { buildAndStageApp, resolveTool } from '@mantle/tools';
import { recordIngest } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';

const Body = AppMetaFields.partial({ name: true }).extend({
  /** Update this app if given; otherwise create a new one (then `name` is required). */
  appId: z.string().uuid().optional(),
  /** Source tree. `entry` must be one of the `files` keys. */
  entry: z.string().min(1).max(MAX_APP_PATH_LEN),
  files: z.record(z.string().max(MAX_APP_PATH_LEN), z.string().max(MAX_APP_FILE_BYTES)),
  /** Runtime data-tool allowlist (host.tools.call). Each must be an owned tool. */
  toolSlugs: z.array(z.string()).max(100).optional(),
  /** Per-app SQLite DDL. */
  schemaSql: z.string().max(100_000).optional(),
  /** Compile after writing (default true). */
  build: z.boolean().optional(),
  /** Publish if the build is green (default false). Implies build. */
  publish: z.boolean().optional(),
});

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid input', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const b = parsed.data;

  // ── check everything before anything is written ──
  if (!Object.hasOwn(b.files, b.entry)) return bad(`entry '${b.entry}' is not one of the files`);
  if (Object.keys(b.files).length > MAX_APP_FILES)
    return bad(`too many files (max ${MAX_APP_FILES})`);
  if (!b.appId && !b.name) return bad('name is required when appId is omitted');
  const existing = b.appId ? await getAppRuntime(user.id, b.appId) : null;
  if (b.appId && !existing) return bad('app not found', 404);
  if (b.toolSlugs) {
    const missing: string[] = [];
    for (const slug of b.toolSlugs) {
      if (!(await resolveTool(user.id, slug))) missing.push(slug);
    }
    if (missing.length) return bad(`unknown tool slug(s): ${missing.join(', ')}`);
  }
  const schemaSql = b.schemaSql?.trim() ? b.schemaSql : null;
  if (schemaSql) {
    try {
      // A new app is tried on an empty database (its id is only a file name).
      await checkAppSchemaScript(user.id, b.appId ?? randomUUID(), schemaSql);
    } catch (err) {
      return bad(errorMessage(err));
    }
  }

  // ── create, or keep what an update replaces ──
  let appId = b.appId;
  let created = false;
  if (!appId) {
    const app = await createApp(user.id, {
      title: b.name!,
      ...(b.icon ? { icon: b.icon } : {}),
      ...(b.color ? { color: b.color } : {}),
      ...(b.description ? { description: b.description } : {}),
      tags: b.tags ?? [],
    });
    appId = app.id;
    created = true;
    void recordIngest({
      source: 'page_create',
      ownerId: user.id,
      nodeId: app.id,
      summary: `App imported: ${app.title.slice(0, 80)}`,
      payload: { title: app.title, via: 'import', kind: 'app' },
      snippet: app.title,
    });
  } else {
    // The data rides along only when the import changes the schema (the one
    // part of an import that reaches the data); every push copying the
    // database filled the disk (apps audit 2026-10-02, item 11). A lost live
    // file keeps the code (item 4).
    await createAppSnapshot(user.id, appId, {
      trigger: 'pre_import',
      actor: 'owner',
      note: 'before an import',
      withData: schemaSql !== null,
      codeOnlyWhenLost: true,
    });
  }

  // ── write the whole source tree to the draft ──
  try {
    const ok = await saveDraftSource(user.id, appId, { entry: b.entry, files: b.files });
    if (!ok) return bad('app not found', 404);
  } catch (err) {
    if (err instanceof AppSourceLimitError) return bad(err.message);
    throw err;
  }
  if (b.toolSlugs) await setManifest(user.id, appId, { toolSlugs: b.toolSlugs });
  if (schemaSql) await declareAppSchema(user.id, appId, schemaSql);

  // ── build + optional publish ──
  const wantBuild = b.build !== false || b.publish === true;
  const build = wantBuild ? await buildAndStageApp(user.id, appId) : null;
  let published = false;
  if (b.publish && build?.buildOk) {
    try {
      await publishApp(user.id, appId, { note: 'imported', actor: 'owner' });
      published = true;
    } catch (err) {
      if (!(err instanceof NoGreenBuildError)) throw err;
    }
  }
  void notifyAppNavChanged(user.id);

  return NextResponse.json({
    ok: true,
    appId,
    created,
    ...(build ? { build } : {}),
    published,
    reviewUrl: `/apps/${appId}`,
  });
}
