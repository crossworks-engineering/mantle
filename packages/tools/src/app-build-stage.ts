/**
 * Build an app's working source (draft, else published) and stage the bundle
 * for preview: the ONE build step (apps audit G6). The `app_build` tool, the
 * editor's Preview and Commit, the import route and `apps:push` all go
 * through it, so the agent and the web surface produce the same artifact.
 * It used to be written out twice, line for line.
 *
 * A failed build never overwrites the last good preview: a BuildRef is
 * recorded on success only; the errors come back for the caller to show.
 *
 * The app build store's broker (workspaces arch A3b, plan 20.3,
 * docs/store-brokers.md): the only writer of app bundles to the object
 * store. The bundle is the stage: stored under its content address, which
 * no app row names yet; then setDraftBuild's one short transaction checks
 * the app row as the caller (the draft_build update, exactly one row; D4:
 * the code needs a Moderator of the app's home) and points it there. A
 * refused or stale build leaves an object nothing points at. Bundles are
 * content-addressed and shared by every app whose build is byte-identical,
 * so no sweep removes them (an object may be another app's, or an email's
 * or a file's with the same bytes); an unreferenced bundle costs only its
 * bytes, and the next identical build reuses it.
 */
import { getApp, setDraftBuild, workingSource } from '@mantle/content';
import { buildApp, loadRuntimeExports, type BuildMessage } from '@mantle/app-build';
import { contentKey, hashBuffer } from '@mantle/storage';
import { putContent } from '@mantle/storage/write';

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
    // The keys are the bytes' hashes: known before anything is stored.
    const js = Buffer.from(res.code, 'utf8');
    const css = res.css ? Buffer.from(res.css, 'utf8') : null;
    const jsSha = hashBuffer(js);
    const cssSha = css ? hashBuffer(css) : null;
    const staged = await setDraftBuild(
      ownerId,
      id,
      {
        storageKey: contentKey(jsSha),
        sha256: jsSha,
        builtAt: new Date().toISOString(),
        esbuildVersion: res.esbuildVersion,
        bytes: js.length,
        ok: true,
        ...(res.warnings.length ? { warnings: res.warnings.map((w) => w.text) } : {}),
        ...(css && cssSha
          ? { css: { storageKey: contentKey(cssSha), sha256: cssSha, bytes: css.length } }
          : {}),
      },
      {
        builtFrom: source,
        // The stage, before the row's flip (A3b, plan 20.3).
        store: async () => {
          await putContent(js, 'application/javascript');
          if (css) await putContent(css, 'text/css');
        },
      },
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
