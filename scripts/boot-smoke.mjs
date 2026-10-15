#!/usr/bin/env node
/**
 * Boot smoke: start every server process the way the image does, up to the
 * point where its import graph links, and fail if one cannot.
 *
 *   node scripts/boot-smoke.mjs            (pnpm boot:smoke; part of pnpm verify)
 *
 * Why: v0.300.64 crash-looped every server process on dev at start with
 * "SyntaxError: The requested module '@mantle/voice-client' does not provide
 * an export named 'normalizeAnthropicWorkspaceId'". The package had no
 * "type": "module", so tsx loaded its barrel as CommonJS and the names it
 * re-exported with `export *` vanished. Typecheck, vitest and the asset build
 * all passed, because none of them runs an entry the way the image does.
 *
 * What it runs: every service in docker-compose.yml on the mantle-server
 * image, with the service's own `command:` (the image CMD from the
 * Dockerfile's server stage for `web`, which has none), from the repo root
 * (the image's WORKDIR). So a new worker service is covered the day it lands
 * in compose. Plus the entries no compose service runs (EXTRA: the stdio MCP
 * server, which a client spawns in mantle_web). Each entry honours
 * MANTLE_BOOT_SMOKE=import-only (packages/config/src/boot-smoke.ts; no other
 * value counts): once its imports are linked it loads what it would load
 * lazily (server/web: every route module and the boot tasks), prints
 * "[boot-smoke] linked: <name>" and exits 0, before it opens a pool, a
 * listener or a queue. No database and no network: the stub DATABASE_URL
 * points at a closed port that nothing dials.
 *
 * A step passes on exit 0 AND its marker line; a `sh -c 'a && b'` command
 * needs one marker per step. Anything else (non-zero exit, a missing marker,
 * a timeout) fails the run and prints the tail of that process's output.
 *
 * What it loads: each entry's static import graph, every web route module
 * (through the route manifest) and the entries' own lazy imports. What it
 * does NOT load: an `await import()` that runs only when a request or a job
 * reaches it, deep inside the graph (the document parsers, native and other
 * third-party modules loaded on first use, and the like). A broken one of
 * those fails that request, not the boot. For workspace packages the guard
 * against the v0.300.64 class of failure is the "type": "module" test in
 * eslint-rules/boot-smoke.test.ts, which covers every package whatever
 * imports it and however.
 *
 * Not covered: sandboxd (profile `sandboxes`) runs on this same image, but it
 * imports no workspace package at all (node: builtins and its own files
 * only), so no cross-package link can break it, and it has no @mantle/config
 * to read the switch, so it would start a real daemon. It is listed in SKIP
 * with that reason.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The marker an entry prints at its checkpoint (BOOT_SMOKE_MARK). */
export const MARK = '[boot-smoke] linked:';

/** Services on the server image that are not smoked, each with its reason. */
export const SKIP = {
  sandboxd:
    'imports no workspace package (node: builtins and its own files only) and has no @mantle/config to read the switch (server/sandboxd)',
};

/** Entries no compose service runs, smoked the way they are started:
 *  the stdio MCP server is spawned by a client, on a box as
 *  `docker exec -i mantle_web pnpm -C server/mcp start` (docs/connecting-claude.md). */
export const EXTRA = [{ name: 'mcp-stdio', command: ['pnpm', '-C', 'server/mcp', 'start'] }];

/** The image every app service runs. */
const SERVER_IMAGE = /\/mantle-server:/;

/** Single-quoted (or double-quoted) strings of a YAML flow sequence. */
function flowStrings(text) {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
}

/**
 * The app services of a compose file: `{ name, command }` for every service
 * on the server image; `command` is null when the service leaves it to the
 * image CMD. Pure, for eslint-rules/boot-smoke.test.ts.
 */
export function composeServices(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === 'services:');
  if (start < 0) throw new Error('compose file has no top-level services: block');
  const services = [];
  let current = null;
  const flush = () => {
    if (!current || !SERVER_IMAGE.test(current.image ?? '')) return;
    let command = null;
    if (current.command !== null) {
      if (!current.command.trimStart().startsWith('[')) {
        throw new Error(
          `service ${current.name}: command is not a flow sequence; extend composeServices`,
        );
      }
      command = flowStrings(current.command);
    }
    services.push({ name: current.name, command });
  };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // the next top-level key
    const svc = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (svc) {
      flush();
      current = { name: svc[1], image: null, command: null };
      continue;
    }
    if (!current) continue;
    const image = /^ {4}image:\s*(\S.*)$/.exec(line);
    if (image) current.image = image[1];
    const cmd = /^ {4}command:\s*(.*)$/.exec(line);
    if (cmd) {
      // A flow sequence, on this line or over the following ones up to `]`
      // (parsed in flush, for a service on the server image only).
      let text = cmd[1];
      if (text.trim() === '') text = lines[++i] ?? '';
      if (text.trimStart().startsWith('[')) {
        while (!text.includes(']') && i + 1 < lines.length) text += '\n' + lines[++i];
      }
      current.command = text;
    }
  }
  flush();
  return services;
}

/** The server stage's CMD in the Dockerfile (what `web` runs). Pure. */
export function serverImageCmd(dockerfile) {
  const stage = dockerfile.split(/^FROM /m).find((s) => /^\S+ AS server\b/.test(s));
  if (!stage) throw new Error('Dockerfile has no `AS server` stage');
  const cmds = [...stage.matchAll(/^CMD (\[.*\])\s*$/gm)];
  if (cmds.length === 0) throw new Error('the server stage has no exec-form CMD');
  return JSON.parse(cmds.at(-1)[1]);
}

/** How many markers a command must print: one per `&&` step of a shell
 *  command, else one. Pure. */
export function stepsOf(command) {
  if (command[0] === 'sh' && command[1] === '-c') return command[2].split('&&').length;
  return 1;
}

/** Stub env: enough for every entry to pass assertEnvShape and reach its
 *  checkpoint; nothing here is ever dialled. Explicit values win over any
 *  .env.local the commands load (--env-file-if-exists, loadEnvFiles). */
export const STUB_ENV = {
  MANTLE_BOOT_SMOKE: 'import-only',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://boot-smoke:boot-smoke@127.0.0.1:9/boot_smoke',
  DBOS_SYSTEM_DATABASE_URL: 'postgres://boot-smoke:boot-smoke@127.0.0.1:9/boot_smoke_dbos',
  SESSION_SECRET: 'boot-smoke-session-secret-not-a-real-one',
  MANTLE_MASTER_KEY: Buffer.alloc(32).toString('base64'),
  MANTLE_PUBLIC_URL: 'http://127.0.0.1:9',
  S3_ENDPOINT: 'http://127.0.0.1:9',
  PORT: '0',
  HOST: '127.0.0.1',
};

const TIMEOUT_MS = 120_000;

/** Run one service's command; resolves to a result row, never rejects. */
function smoke(svc) {
  const started = Date.now();
  return new Promise((resolve) => {
    const [bin, ...args] = svc.command;
    const child = spawn(bin, args, {
      cwd: ROOT,
      env: { ...process.env, ...STUB_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      out += `\n[boot-smoke] timed out after ${TIMEOUT_MS / 1000}s`;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const marks = out.split('\n').filter((l) => l.includes(MARK)).length;
      const want = stepsOf(svc.command);
      const ok = code === 0 && marks === want;
      const why = ok
        ? ''
        : code !== 0 || signal
          ? `exit ${code ?? signal}`
          : `exit 0 but ${marks}/${want} checkpoint line(s): an entry did not reach its checkpoint`;
      resolve({ ...svc, ok, why, out, ms: Date.now() - started });
    });
  });
}

async function main() {
  const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const cmd = serverImageCmd(dockerfile);
  const all = composeServices(compose).map((s) => ({ ...s, command: s.command ?? cmd }));
  const services = [...all.filter((s) => !(s.name in SKIP)), ...EXTRA];
  for (const s of all.filter((s) => s.name in SKIP)) {
    console.log(`- ${s.name}: skipped (${SKIP[s.name]})`);
  }
  if (!services.some((s) => s.name === 'web') || !services.some((s) => s.name === 'api')) {
    throw new Error('compose parse found no web or api service; composeServices needs a look');
  }

  // server/web loads its routes through the generated manifest (gitignored,
  // written by the image build); write it so the web entry can load them.
  const gen = spawnSync('pnpm', ['-C', 'server/web', 'route-manifest'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (gen.status !== 0) throw new Error('pnpm -C server/web route-manifest failed');

  // Each process loads the whole workspace (300-400 MB): at most 4 at once.
  const jobs = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
  console.log(`boot smoke: ${services.length} services, ${jobs} at a time`);
  const t0 = Date.now();
  const queue = [...services];
  const results = [];
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const r = await smoke(s);
        results.push(r);
        console.log(
          `${r.ok ? '✓' : '✗'} ${r.name} (${(r.ms / 1000).toFixed(1)}s)${r.ok ? '' : `: ${r.why}`}`,
        );
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    console.error(`\n✗ ${r.name}: ${r.command.join(' ')}\n  ${r.why}; last lines:`);
    console.error(
      r.out
        .trimEnd()
        .split('\n')
        .slice(-40)
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (failed.length > 0) {
    console.error(
      `\nboot smoke FAILED: ${failed.length}/${results.length} services cannot start (${secs}s)`,
    );
    process.exit(1);
  }
  console.log(`boot smoke ok: ${results.length} services link (${secs}s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('boot smoke could not run:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
