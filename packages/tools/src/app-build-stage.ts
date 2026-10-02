/**
 * Build an app's working source (draft, else published) and stage the bundle
 * for preview: the ONE build step (apps audit G6). The `app_build` tool, the
 * editor's Preview and Commit, the import route and `apps:push` all go
 * through it, so the agent and the web surface produce the same artifact.
 * It used to be written out twice, line for line.
 *
 * A failed build never overwrites the last good preview: a BuildRef is
 * recorded on success only; the errors come back for the caller to show.
 */
import { getApp, setDraftBuild, workingSource } from '@mantle/content';
import { buildApp, loadRuntimeExports, type BuildMessage } from '@mantle/app-build';
import { putContent } from '@mantle/storage';

export type AppBuildOutcome = {
  buildOk: boolean;
  errors: BuildMessage[];
  warnings: BuildMessage[];
  /** The bundle's size in bytes (0 when the build failed). */
  bytes: number;
};

/** Null when the app is not this owner's. */
export async function buildAndStageApp(
  ownerId: string,
  id: string,
): Promise<AppBuildOutcome | null> {
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
