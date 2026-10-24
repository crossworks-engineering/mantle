/**
 * server/web entry point — the Hono replacement for `next start`/`next dev`.
 * Run via tsx (dev: `tsx watch server/main.ts`, prod: image CMD), like
 * server/api and every worker already are.
 *
 * Order matters: env files load BEFORE any app import, because workspace
 * packages capture env at module init (DATABASE_URL, S3_*, …).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from './env';
import { assertEnvShape, bootSmokeExit, env, envNum, isBootSmoke } from '@mantle/config';
import { onShutdown } from '@mantle/std/shutdown';
import { log } from '@mantle/tracing';

const bootLog = log('boot');
const serverLog = log('server');

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFiles(webRoot);
assertEnvShape();

// Build identity. Next used to inline NEXT_PUBLIC_* at compile time; under tsx
// the shared @mantle/client-types/version module reads the same vars at import — so
// resolve them HERE, before anything imports it. Version comes from the ROOT
// package.json (single source of truth); SHA + build time are stamped into the
// image as MANTLE_* (Dockerfile build args).
try {
  const rootPkg = JSON.parse(readFileSync(join(webRoot, '../../package.json'), 'utf8')) as {
    version?: string;
  };
  process.env.NEXT_PUBLIC_APP_VERSION ??= rootPkg.version ?? '0.0.0';
} catch {
  /* keep the module's 0.0.0 fallback */
}
process.env.NEXT_PUBLIC_GIT_SHA ??= process.env.MANTLE_GIT_SHA ?? '';
process.env.NEXT_PUBLIC_BUILD_TIME ??= process.env.MANTLE_BUILD_TIME ?? '';

// Recall's embedder, injected before anything can serve a request.
// @mantle/content is storage and does not depend on the adapter layer, so the
// process that owns the adapters registers one at boot (see
// packages/content/src/embed-bridge.ts). This is the entrypoint that matters
// most for Recall: the maps are authored in the editor, and a commit here is
// what compiles them. Without the registration a map still compiles but its
// prompt rows keep a null embedding, so recall_match silently returns nothing
// — the bridge throws so it lands in the log instead.
//
// AWAITED, not top-level `import`: env files must load before @mantle/embeddings
// initialises, exactly like the two imports below.
// recall-embed-registration.test.ts pins this call in all three entrypoints.
const { registerRecallEmbedder } = await import('@mantle/content');
const { embedBatch } = await import('@mantle/embeddings');
registerRecallEmbedder(embedBatch);

// The canvas renderer (Present): the tools that draw a canvas reach the
// browser sidecar through it (packages/tools canvas-render-bridge.ts).
// server/api (the agent turns) and server/mcp register the same one.
const { registerCanvasRenderer } = await import('@mantle/tools');
const { renderCanvas } = await import('@mantle/tools/canvas-render');
registerCanvasRenderer(renderCanvas);

// The one gate (arch A3c fix round 2, M-A): every narrower registered, or
// the process stops here at boot, not at its first request (every routed
// request runs through the gate since A4 step 1). AWAITED like
// the imports above (env first). gate-boot.test.ts pins this call in every
// process entry.
const { ensureGateReady } = await import('@mantle/tools/gate-narrowers');
ensureGateReady();

// One audit row for every tool write (A5 step 6d, @mantle/db call-audit.ts): an
// assistant turn's, an app broker's, the dev console's, a login's own MCP
// writes, with the request's ip and user agent. Off in detached dev (no local
// database), as the route audit is.
const { startCallAudit } = await import('@mantle/db');
const { getRequestContext } = await import('./request-context');
const { requestMetaFrom } = await import('../lib/audit');
const { isDetachedDev } = await import('../lib/auth-constants');
startCallAudit({
  enabled: !isDetachedDev(),
  meta: () => {
    const ctx = getRequestContext();
    return ctx ? requestMetaFrom(ctx.req) : null;
  },
});

const { serve } = await import('@hono/node-server');
const { createApp } = await import('./app');

// Boot smoke (scripts/boot-smoke.mjs): the import graph above is linked; load
// what this process would load later (the app's pages, every route module the
// manifest loads on its first hit, the boot tasks below) and exit 0 before a
// pool, a task or a listener starts. Every literal import() below this block
// is listed in it (boot-smoke.test.ts).
if (isBootSmoke()) {
  await bootSmokeExit('web', [
    () => createApp(),
    async () => {
      // Each module's policy export is the one its manifest entry read (S9).
      const { routeManifest } = await import('./route-manifest.gen');
      const { checkLoadedPolicy } = await import('./route-loader');
      for (const route of routeManifest) {
        checkLoadedPolicy(route, await route.load());
      }
    },
    () => import('../lib/system-manifest/reconcile'),
    () => import('../lib/workspaces-migrate'),
    () => import('../lib/snapshot-copies'),
    () => import('@mantle/content/app-table-exports'),
  ]);
}

// Arch A2a: each boot task runs as system(boot:<task>).
const { runAsSystem, openLoginWritePool, systemWork } = await import('@mantle/db');
// Arch A2b2b: this process sends scoped login writes to the write role
// (docs/actors.md; the connection ceiling counts its pool for each process
// that opens it).
openLoginWritePool();

// A brain with no workspaces yet (a fresh install whose owner signed up
// before this release, W5b1 audit M1): migrate it once. Skips a migrated
// brain and one with clients (21.9) without a lock; no LLM work. Awaited
// before the listener (arch A7): this release has no rule for a brain off
// workspaces, so the boot refuses one (a box that reports "clients
// present", or a switch that failed) and exits; a fresh install with no
// owner yet serves its signup. A database the boot cannot read is not a
// refusal: logged, as before. Detached dev has no database of its own: the
// step runs as before, never awaited.
// Then the authors' copies of their accepted items (W6b, plan S3): only the
// missing ones, no LLM work, no extractor notify.
// The boot's assistant attach is workspace system work (0307
// a2: the SQL allowlist's system:boot:migrate-workspaces): systemWork.
const workspacesStep = () =>
  systemWork(
    () =>
      import('../lib/workspaces-migrate').then(async (wm) => {
        await wm.migrateWorkspacesQuietly('boot');
        const why = await wm.unmigratedBrainReason();
        return why === null ? null : wm.unmigratedBrainRefusal(why);
      }),
    'boot:migrate-workspaces',
  ).catch((err) => {
    bootLog.error('workspaces migration failed:', err);
    return null;
  });
const snapshotCopies = () =>
  runAsSystem('boot:snapshot-copies', () =>
    import('../lib/snapshot-copies')
      .then(({ makeSnapshotCopies }) => makeSnapshotCopies())
      .then((r) => {
        if (r.made > 0 || r.acceptedRowsCleared > 0) {
          bootLog.info(
            `snapshot copies: made ${r.made}, accepted rows cleared ${r.acceptedRowsCleared}`,
          );
        }
      })
      .catch((err) => bootLog.error('workspaces migration failed:', err)),
  );
if (isDetachedDev()) {
  void workspacesStep().then(snapshotCopies);
} else {
  const unmigrated = await workspacesStep();
  if (unmigrated) {
    bootLog.error(unmigrated);
    process.exit(1);
  }
  void snapshotCopies();
}

// Boot hook (was instrumentation.ts): bring an existing brain in line with the
// system manifest on every image update, once the brain is known to be on
// workspaces (arch A7: the reconcile has no rule for one that is not).
// Fire-and-forget: never delays or blocks request serving; the reconcile
// self-guards (production-only, provisioned-only, once per version,
// best-effort).
// (MANTLE_PUBLIC_URL / NEXT_PUBLIC_APP_URL fallback: @mantle/config warns once.)
void runAsSystem('boot:manifest-reconcile', () =>
  import('../lib/system-manifest/reconcile')
    .then(({ reconcileManifestOnBoot }) => reconcileManifestOnBoot())
    .catch((err) => bootLog.error('manifest reconcile failed:', err)),
);

// App table exports a restart left unsynced (apps plan D8): their debounce
// timers died with the old process. The usual hash-gated sync, once.
void runAsSystem('boot:app-table-exports', () =>
  import('@mantle/content/app-table-exports')
    .then(({ resumeDirtyAppTableExports }) => resumeDirtyAppTableExports())
    .then((n) => {
      if (n > 0) bootLog.info(`resumed the table export sync of ${n} app(s)`);
    })
    .catch((err) => bootLog.error('app table export resume failed:', err)),
);

const app = await createApp();
const port = envNum('PORT');
const hostname = env('HOST') || '0.0.0.0';

// overrideGlobalObjects: false is a SECURITY setting, not a tuning knob. By
// default @hono/node-server swaps `global.Response` for its own class when
// serve() runs, AFTER our modules loaded: NextResponse (server/http-compat)
// still extends the original, so every route's `if (user instanceof Response)
// return user` was false for the 401/403 that getOwnerOr401 returns, and the
// handler ran on with the refusal object as its "user". That let a member
// login (and a revoked bearer) into admin handlers; only the ones that query
// by `user.id` crashed. Found live on dev, 2026-09-26. Pinned by
// server-globals.test.ts.
const server = serve({ fetch: app.fetch, port, hostname, overrideGlobalObjects: false }, (info) => {
  serverLog.info(`mantle server/web (hono) listening on http://${hostname}:${info.port}`);
});

// Compose sends SIGTERM on stop/update — close the listener, let in-flight
// requests finish, and bail hard if something (an SSE stream) pins the process.
// NOTE: signals only reach us via `pnpm exec tsx …` (the image CMD + worker
// form); the `pnpm run` script form interposes an sh layer that swallows them.
// The one shutdown helper (@mantle/std/shutdown, A10 #15): the listener
// closes, and the deadline exits 0 after 5 s as before.
onShutdown({
  name: 'server',
  deadlineMs: 5000,
  deadlineExitCode: 0,
  stop: () => new Promise<void>((done) => server.close(() => done())),
});

// Next's server logged process-level failures and stayed up; bare node's
// default is to CRASH on an unhandled rejection — and this app deliberately
// fire-and-forgets promises (view counters, audit rows, boot reconcile), so a
// detached rejection must never take the web tier down. Mirrors server/api's
// runtime guard. Uncaught exceptions log-and-continue too: with request errors
// already contained by app.onError, anything reaching here is a background
// task, and killing live SSE streams over it is the worse failure.
process.on('unhandledRejection', (reason) => {
  serverLog.error('unhandled rejection (continuing):', reason);
});
process.on('uncaughtException', (err) => {
  serverLog.error('uncaught exception (continuing):', err);
});
