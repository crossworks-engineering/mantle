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
import { assertEnvShape } from '@mantle/config';

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

// The one gate (arch A3c fix round 2, M-A): every narrower registered, or
// the process stops here at boot, not at its first request (the gate has
// production callers since A4 step 1: every routed request). AWAITED like
// the imports above (env first). gate-boot.test.ts pins this call in every
// process entry.
const { ensureGateReady } = await import('@mantle/tools/gate-narrowers');
ensureGateReady();

const { serve } = await import('@hono/node-server');
const { createApp } = await import('./app');

// Boot hook (was instrumentation.ts): bring an existing brain in line with the
// system manifest on every image update. Fire-and-forget — never delays or
// blocks request serving; the reconcile self-guards (production-only,
// provisioned-only, once per version, best-effort).
// (MANTLE_PUBLIC_URL / NEXT_PUBLIC_APP_URL fallback: @mantle/config warns once.)
// Arch A2a: each boot task runs as system(boot:<task>).
const { runAsSystem, openLoginWritePool } = await import('@mantle/db');
// Arch A2b2b: this process sends scoped login writes to the write role
// (docs/actors.md; the connection ceiling counts its pool for web and api).
openLoginWritePool();
void runAsSystem('boot:manifest-reconcile', () =>
  import('../lib/system-manifest/reconcile')
    .then(({ reconcileManifestOnBoot }) => reconcileManifestOnBoot())
    .catch((err) => console.error('[boot] manifest reconcile failed:', err)),
);

// A brain with no workspaces yet (a fresh install whose owner signed up
// before this release, W5b1 audit M1): migrate it once. Skips a migrated
// brain and one with clients (21.9) without a lock; no LLM work.
// Then the authors' copies of their accepted items (W6b, plan S3): only the
// missing ones, no LLM work, no extractor notify.
void runAsSystem('boot:migrate-workspaces', () =>
  import('../lib/workspaces-migrate')
    .then(({ migrateWorkspacesQuietly }) => migrateWorkspacesQuietly('boot'))
    .then(() => import('../lib/snapshot-copies'))
    .then(({ makeSnapshotCopies }) => makeSnapshotCopies())
    .then((r) => {
      if (r.made > 0 || r.acceptedRowsCleared > 0) {
        console.log(
          `[boot] snapshot copies: made ${r.made}, accepted rows cleared ${r.acceptedRowsCleared}`,
        );
      }
    })
    .catch((err) => console.error('[boot] workspaces migration failed:', err)),
);

// App table exports a restart left unsynced (apps plan D8): their debounce
// timers died with the old process. The usual hash-gated sync, once.
void runAsSystem('boot:app-table-exports', () =>
  import('@mantle/content/app-table-exports')
    .then(({ resumeDirtyAppTableExports }) => resumeDirtyAppTableExports())
    .then((n) => {
      if (n > 0) console.log(`[boot] resumed the table export sync of ${n} app(s)`);
    })
    .catch((err) => console.error('[boot] app table export resume failed:', err)),
);

const app = await createApp();
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || '0.0.0.0';

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
  console.log(`[server] mantle server/web (hono) listening on http://${hostname}:${info.port}`);
});

// Compose sends SIGTERM on stop/update — close the listener, let in-flight
// requests finish, and bail hard if something (an SSE stream) pins the process.
// NOTE: signals only reach us via `pnpm exec tsx …` (the image CMD + worker
// form); the `pnpm run` script form interposes an sh layer that swallows them.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[server] ${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

// Next's server logged process-level failures and stayed up; bare node's
// default is to CRASH on an unhandled rejection — and this app deliberately
// fire-and-forgets promises (view counters, audit rows, boot reconcile), so a
// detached rejection must never take the web tier down. Mirrors server/api's
// runtime guard. Uncaught exceptions log-and-continue too: with request errors
// already contained by app.onError, anything reaching here is a background
// task, and killing live SSE streams over it is the worse failure.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection (continuing):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception (continuing):', err);
});
