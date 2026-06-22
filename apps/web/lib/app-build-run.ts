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
import { buildApp, type BuildMessage } from '@mantle/app-build';
import { putContent } from '@mantle/storage';

export type AppBuildOutcome = {
  buildOk: boolean;
  errors: BuildMessage[];
  warnings: BuildMessage[];
  bytes: number;
};

export async function runAppBuild(ownerId: string, id: string): Promise<AppBuildOutcome | null> {
  const app = await getApp(ownerId, id);
  if (!app) return null;
  const res = await buildApp(workingSource(app));
  if (res.ok && res.code) {
    const put = await putContent(Buffer.from(res.code, 'utf8'), 'application/javascript');
    await setDraftBuild(ownerId, id, {
      storageKey: put.key,
      sha256: put.sha256,
      builtAt: new Date().toISOString(),
      esbuildVersion: res.esbuildVersion,
      bytes: put.size,
      ok: true,
      ...(res.warnings.length ? { warnings: res.warnings.map((w) => w.text) } : {}),
    });
  }
  return {
    buildOk: res.ok,
    errors: res.errors,
    warnings: res.warnings,
    bytes: res.code ? Buffer.byteLength(res.code, 'utf8') : 0,
  };
}
