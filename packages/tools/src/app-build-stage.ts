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

/** Builds of source that changed meanwhile, before the step gives up. */
const STALE_RETRIES = 2;

/** Null when the app is not this owner's. A build of source that changed
 *  while it ran is not recorded (setDraftBuild 'stale'): the step builds
 *  the new source, a few times, then reports the build as not staged. */
export async function buildAndStageApp(
  ownerId: string,
  id: string,
): Promise<AppBuildOutcome | null> {
  for (let attempt = 0; ; attempt++) {
    const app = await getApp(ownerId, id);
    if (!app) return null;
    const source = workingSource(app);
    const res = await buildApp(source, {
      declaredToolSlugs: app.manifest.toolSlugs ?? [],
      runtimeExports: await loadRuntimeExports(),
    });
    const outcome: AppBuildOutcome = {
      buildOk: res.ok,
      errors: res.errors,
      warnings: res.warnings,
      bytes: res.code ? Buffer.byteLength(res.code, 'utf8') : 0,
    };
    if (!res.ok || !res.code) return outcome;
    const put = await putContent(Buffer.from(res.code, 'utf8'), 'application/javascript');
    const cssPut = res.css ? await putContent(Buffer.from(res.css, 'utf8'), 'text/css') : null;
    const staged = await setDraftBuild(
      ownerId,
      id,
      {
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
      },
      { builtFrom: source },
    );
    if (staged === false) return null;
    if (staged === true) return outcome;
    if (attempt >= STALE_RETRIES) {
      return {
        ...outcome,
        buildOk: false,
        errors: [
          {
            text: 'the source changed while it was building, again and again: build it again when the edits stop',
            location: null,
          },
        ],
      };
    }
  }
}
