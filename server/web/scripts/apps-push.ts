/**
 * apps:push — push a local directory of mini-app source into Mantle, build it,
 * and (optionally) publish. The headless counterpart to the /api/apps/import
 * route, for a single-user box: the owner is resolved at boot from
 * ALLOWED_USER_ID / the sole auth.users row (same trust model as apps/mcp), so
 * no session/API-key auth is needed — you must already have shell access.
 *
 * Usage:
 *   pnpm -C server/web apps:push <dir> [--name "My App"] [--id <uuid>]
 *                                    [--entry App.tsx] [--publish] [--no-build]
 *   # or, from the repo root:  pnpm apps:push <dir> [flags]
 *
 * Optional <dir>/mantle-app.json supplies metadata + bindings:
 *   { "name", "entry", "description", "icon", "tags": [],
 *     "toolSlugs": ["app_recent_notes"], "schemaSql": "CREATE TABLE …" }
 * CLI flags override the manifest. Build + publish reuse runAppBuild() and
 * publishApp() — the same path the web Build/Publish buttons and the app_*
 * builtins use, so this produces identical artifacts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveSingleOwnerId } from '@mantle/db';
import {
  createApp,
  saveDraftSource,
  getApp,
  setManifest,
  publishApp,
  AppSourceLimitError,
  NoGreenBuildError,
} from '@mantle/content';
import { assertSafeScript } from '@mantle/content/app-broker';
import { resolveTool } from '@mantle/tools';
import { runAppBuild } from '../lib/app-build-run';

function die(msg: string): never {
  console.error(`apps-push: ${msg}`);
  process.exit(1);
}

// ── args ──
const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a == null) continue;
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    positional.push(a);
  }
}
const dir = positional[0];
if (!dir) {
  die('usage: pnpm apps:push <dir> [--name ..] [--id ..] [--entry ..] [--publish] [--no-build]');
}
const srcDir: string = dir;

// ── collect source tree ──
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const MANIFEST_FILE = 'mantle-app.json';
const files: Record<string, string> = {};
function walk(abs: string) {
  for (const name of readdirSync(abs)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(abs, name);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else {
      const rel = relative(srcDir, full).split(sep).join('/');
      if (rel === MANIFEST_FILE) continue; // metadata, not app source
      files[rel] = readFileSync(full, 'utf8');
    }
  }
}
try {
  walk(srcDir);
} catch (err) {
  die(`cannot read '${srcDir}': ${err instanceof Error ? err.message : String(err)}`);
}
if (Object.keys(files).length === 0) die(`no source files found in '${dir}'`);

// ── manifest (optional) + flag overrides ──
type Manifest = {
  name?: string;
  entry?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  toolSlugs?: string[];
  schemaSql?: string;
};
let manifest: Manifest = {};
try {
  manifest = JSON.parse(readFileSync(join(srcDir, MANIFEST_FILE), 'utf8')) as Manifest;
} catch {
  /* no manifest — fine */
}

const flagStr = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
const entry = flagStr('entry') ?? manifest.entry ?? (files['App.tsx'] ? 'App.tsx' : undefined);
if (!entry)
  die(
    'could not determine the entry file — pass --entry, add an App.tsx, or set it in mantle-app.json',
  );
if (!(entry in files)) die(`entry '${entry}' is not among the collected files`);

const wantPublish = flags.publish === true;
const wantBuild = flags['no-build'] !== true || wantPublish;
const source = { entry, files };

// ── run ──
const ownerId = await resolveSingleOwnerId();
if (!ownerId) die('no account found (set ALLOWED_USER_ID or create the web-app account first)');

let id = flagStr('id');
if (!id) {
  const name = flagStr('name') ?? manifest.name;
  if (!name) die('--name is required when not updating an existing app (--id)');
  const app = await createApp(ownerId, {
    title: name,
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    tags: manifest.tags ?? [],
  });
  id = app.id;
  console.log(`created app ${id} ("${app.title}")`);
}

try {
  const ok = await saveDraftSource(ownerId, id, source);
  if (!ok) die(`app ${id} not found`);
} catch (err) {
  if (err instanceof AppSourceLimitError) die(err.message);
  throw err;
}
console.log(`wrote ${Object.keys(files).length} file(s); entry=${entry}`);

if (manifest.toolSlugs?.length) {
  const missing: string[] = [];
  for (const slug of manifest.toolSlugs) {
    if (!(await resolveTool(ownerId, slug))) missing.push(slug);
  }
  if (missing.length) {
    die(`unknown tool slug(s): ${missing.join(', ')} — build them first (toolsmith / API Console)`);
  }
  await setManifest(ownerId, id, { toolSlugs: manifest.toolSlugs });
  console.log(`declared tools: ${manifest.toolSlugs.join(', ')}`);
}

if (manifest.schemaSql?.trim()) {
  try {
    assertSafeScript(manifest.schemaSql);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  const app = await getApp(ownerId, id);
  const nextVersion = (app?.manifest.sqlite?.schemaVersion ?? 0) + 1;
  await setManifest(ownerId, id, {
    sqlite: { schemaSql: manifest.schemaSql, schemaVersion: nextVersion },
  });
  console.log(`set sqlite schema (v${nextVersion})`);
}

if (wantBuild) {
  const outcome = await runAppBuild(ownerId, id);
  if (!outcome) die(`app ${id} not found`);
  for (const w of outcome.warnings) console.warn(`  warning: ${w.text}`);
  if (!outcome.buildOk) {
    for (const e of outcome.errors) console.error(`  error: ${e.text}`);
    die('build failed — fix the reported errors and push again');
  }
  console.log(`build ok (${outcome.bytes} bytes)`);

  if (wantPublish) {
    try {
      await publishApp(ownerId, id);
      console.log('published');
    } catch (err) {
      if (err instanceof NoGreenBuildError) die(err.message);
      throw err;
    }
  }
}

console.log(`done — review at /apps/${id}`);
process.exit(0);
