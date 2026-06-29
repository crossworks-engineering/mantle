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
 * Mirrors the app_* builtins (createApp / saveDraftSource / setManifest /
 * runAppBuild / publishApp) — the same handlers the agent and MCP client use.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  createApp,
  saveDraftSource,
  getApp,
  setManifest,
  publishApp,
  AppSourceLimitError,
  NoGreenBuildError,
  MAX_APP_FILES,
  MAX_APP_FILE_BYTES,
  MAX_APP_PATH_LEN,
} from '@mantle/content';
import { assertSafeScript } from '@mantle/content/app-broker';
import { resolveTool } from '@mantle/tools';
import { runAppBuild } from '@/lib/app-build-run';

export const runtime = 'nodejs';

const Body = z.object({
  /** Update this app if given; otherwise create a new one (then `name` is required). */
  appId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
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
    return NextResponse.json({ error: 'invalid input', detail: parsed.error.flatten() }, { status: 400 });
  }
  const b = parsed.data;

  if (!(b.entry in b.files)) return bad(`entry '${b.entry}' is not one of the files`);
  if (Object.keys(b.files).length > MAX_APP_FILES) return bad(`too many files (max ${MAX_APP_FILES})`);

  // ── create or locate ──
  let appId = b.appId;
  let created = false;
  if (!appId) {
    if (!b.name) return bad('name is required when appId is omitted');
    const app = await createApp(user.id, {
      title: b.name,
      ...(b.icon ? { icon: b.icon } : {}),
      ...(b.description ? { description: b.description } : {}),
      tags: b.tags ?? [],
    });
    appId = app.id;
    created = true;
  }

  // ── write the whole source tree to the draft ──
  try {
    const ok = await saveDraftSource(user.id, appId, { entry: b.entry, files: b.files });
    if (!ok) return bad('app not found', 404);
  } catch (err) {
    if (err instanceof AppSourceLimitError) return bad(err.message);
    throw err;
  }

  // ── declare the data-tool allowlist (validate each slug is owned) ──
  if (b.toolSlugs) {
    const missing: string[] = [];
    for (const slug of b.toolSlugs) {
      if (!(await resolveTool(user.id, slug))) missing.push(slug);
    }
    if (missing.length) return bad(`unknown tool slug(s): ${missing.join(', ')}`);
    await setManifest(user.id, appId, { toolSlugs: b.toolSlugs });
  }

  // ── declare the per-app SQLite schema (bump version) ──
  if (b.schemaSql && b.schemaSql.trim()) {
    try {
      assertSafeScript(b.schemaSql);
    } catch (err) {
      return bad(err instanceof Error ? err.message : String(err));
    }
    const app = await getApp(user.id, appId);
    const nextVersion = (app?.manifest.sqlite?.schemaVersion ?? 0) + 1;
    await setManifest(user.id, appId, { sqlite: { schemaSql: b.schemaSql, schemaVersion: nextVersion } });
  }

  // ── build + optional publish ──
  const wantBuild = b.build !== false || b.publish === true;
  const build = wantBuild ? await runAppBuild(user.id, appId) : null;
  let published = false;
  if (b.publish && build?.buildOk) {
    try {
      await publishApp(user.id, appId);
      published = true;
    } catch (err) {
      if (!(err instanceof NoGreenBuildError)) throw err;
    }
  }

  return NextResponse.json({
    ok: true,
    appId,
    created,
    ...(build ? { build } : {}),
    published,
    reviewUrl: `/apps/${appId}`,
  });
}
