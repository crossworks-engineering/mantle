/**
 * Build the working (draft ?? published) source of an app and stage the bundle
 * for preview. Shared by the /api/apps/[id]/build route and the ai-assist route
 * (which rebuilds after Appsmith edits). Mirrors the app_build builtin so the
 * web surface and the agent produce identical artifacts.
 *
 * A failed build never overwrites the last good preview (we only persist a
 * BuildRef on success); the errors are returned for the caller to surface.
 */
import { getApp, workingSource, setDraftBuild } from '@mantle/content';
import { buildApp, loadRuntimeExports, type BuildMessage } from '@mantle/app-build';
import { putContent } from '@mantle/storage';
// Apps now externalize React/kit/@host to the shared /app-runtime import map.

export type AppBuildOutcome = {
  buildOk: boolean;
  errors: BuildMessage[];
  warnings: BuildMessage[];
  bytes: number;
};

export async function runAppBuild(ownerId: string, id: string): Promise<AppBuildOutcome | null> {
  const app = await getApp(ownerId, id);
  if (!app) return null;
  const res = await buildApp(workingSource(app), {
    declaredToolSlugs: app.manifest.toolSlugs ?? [],
    runtimeExports: await loadRuntimeExports(),
  });
  if (res.ok && res.code) {
    const put = await putContent(Buffer.from(res.code, 'utf8'), 'application/javascript');
    const cssPut = res.css ? await putContent(Buffer.from(res.css, 'utf8'), 'text/css') : null;
    await setDraftBuild(ownerId, id, {
      storageKey: put.key,
      sha256: put.sha256,
      builtAt: new Date().toISOString(),
      esbuildVersion: res.esbuildVersion,
      bytes: put.size,
      ok: true,
      ...(res.warnings.length ? { warnings: res.warnings.map((w) => w.text) } : {}),
      ...(cssPut
        ? { css: { storageKey: cssPut.key, sha256: cssPut.sha256, bytes: cssPut.size } }
        : {}),
    });
  }
  return {
    buildOk: res.ok,
    errors: res.errors,
    warnings: res.warnings,
    bytes: res.code ? Buffer.byteLength(res.code, 'utf8') : 0,
  };
}
