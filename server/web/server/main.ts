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

const { serve } = await import('@hono/node-server');
const { createApp } = await import('./app');

// Boot hook (was instrumentation.ts): bring an existing brain in line with the
// system manifest on every image update. Fire-and-forget — never delays or
// blocks request serving; the reconcile self-guards (production-only,
// provisioned-only, once per version, best-effort).
// (MANTLE_PUBLIC_URL / NEXT_PUBLIC_APP_URL fallback: @mantle/config warns once.)
void import('../lib/system-manifest/reconcile')
  .then(({ reconcileManifestOnBoot }) => reconcileManifestOnBoot())
  .catch((err) => console.error('[boot] manifest reconcile failed:', err));

const app = await createApp();
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || '0.0.0.0';

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
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
