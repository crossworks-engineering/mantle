#!/usr/bin/env node
/**
 * P6b — the coverage gate. Walk EVERY route in client/web/app against the
 * running demo in a real browser and assert each one actually renders.
 *
 *   node demo/check/routes.mjs [base-url]      default: http://127.0.0.1:56080
 *   DEMO_CHECK_ONLY=/journal,/traces node demo/check/routes.mjs
 *
 * WHY A BROWSER, AND WHY <main>:
 * This is the phase that would have caught v1's 85 blank screens, and the
 * failure it exists to catch is invisible to curl. A screen served by
 * `next dev` behind the edge returns 200 with complete, well-formed HTML and
 * still renders nothing: the client never hydrates, so <main> holds an
 * unresolved React placeholder forever. Page BYTES cannot detect that — the
 * nav shell alone is ~103KB, so an entirely empty screen sails past any size
 * floor. The only honest measure is rendered text inside the content region,
 * read from a browser after hydration.
 *
 * READ-ONLY. The demo is served by a read-only edge over a read-only Postgres
 * role; a gate that writes would either 403 or corrupt the thing it measures.
 * Navigation is GET-only, and any non-GET the app fires is reported.
 *
 * NOT part of the pnpm workspace and no dependencies of its own — same reason
 * as demo/generator: joining the workspace means editing a main-owned file,
 * and this branch may only add files under demo/. Playwright is resolved from
 * the e2e package, which already has it installed with browsers.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const APP_DIR = join(ROOT, 'client/web/app');
const BASE = (process.argv[2] || 'http://127.0.0.1:56080').replace(/\/$/, '');

// Text shorter than this in <main> is not a rendered screen. Generous on
// purpose: the point is to separate "nothing at all" from "an honest empty
// state", not to police wording.
const THIN_CHARS = 120;

// ── Playwright, borrowed from e2e ───────────────────────────────────────────
const require = createRequire(import.meta.url);
let chromium;
try {
  // require, not import: @playwright/test is CommonJS and its named exports do
  // not survive ESM interop here — `chromium` comes back undefined.
  const entry = require.resolve('@playwright/test', { paths: [join(ROOT, 'e2e')] });
  chromium = require(entry).chromium;
  if (!chromium) throw new Error('@playwright/test loaded but exposes no chromium');
} catch (err) {
  console.error('✗ cannot load Playwright from e2e/ — run `pnpm -C e2e install` first');
  console.error('  ' + err.message);
  process.exit(2);
}

// ── The route list is DERIVED, never hand-maintained ────────────────────────
// A hardcoded list stops covering new screens the moment someone adds one, and
// this gate exists precisely so nothing goes unlooked-at.
function routeFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) routeFiles(p, acc);
    else if (e.name === 'page.tsx') acc.push(p);
  }
  return acc;
}
const allRoutes = routeFiles(APP_DIR)
  .map((f) => {
    const r = f
      .slice(APP_DIR.length)
      .replace(/\/page\.tsx$/, '')
      .replace(/\/\([^/]+\)/g, ''); // route groups are not URL segments
    return r === '' ? '/' : r;
  })
  .sort();

// ── Fixtures for dynamic segments, fetched read-only from the live demo ─────
const getJson = async (path) => {
  try {
    const r = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};
const pluck = (obj, key) => {
  if (!obj) return null;
  const list = Array.isArray(obj) ? obj : obj[key];
  return Array.isArray(list) && list.length && list[0].id ? list[0].id : null;
};

const f = {};
await Promise.all([
  getJson('/api/notes?limit=1').then((d) => (f.note = pluck(d, 'notes'))),
  getJson('/api/pages?limit=1').then((d) => (f.page = pluck(d, 'pages'))),
  getJson('/api/tables?limit=1').then((d) => (f.table = pluck(d, 'tables'))),
  getJson('/api/traces?limit=1').then((d) => (f.trace = pluck(d, 'traces'))),
  getJson('/api/events?limit=1').then((d) => (f.event = pluck(d, 'events'))),
  getJson('/api/secrets?limit=1').then((d) => (f.secret = pluck(d, 'secrets'))),
  getJson('/api/apps?limit=1').then((d) => (f.app = pluck(d, 'apps'))),
  getJson('/api/heartbeats').then((d) => (f.heartbeat = pluck(d, 'heartbeats'))),
  getJson('/api/contacts?limit=1').then((d) => (f.contact = pluck(d, 'contacts'))),
]);
f.node = f.note; // /n/[id] and /nodes/[id]/history take any node

// Which fixture fills which segment. A route whose fixture is missing is
// SKIPPED and reported as such — never silently dropped, and never counted as
// a pass. Nothing is seeded for apps or heartbeats, so those are expected.
const FIXTURES = [
  ['/notes/[id]', () => f.note && `/notes/${f.note}`],
  ['/pages/[id]', () => f.page && `/pages/${f.page}`],
  ['/tables/[id]', () => f.table && `/tables/${f.table}`],
  ['/traces/[id]', () => f.trace && `/traces/${f.trace}`],
  ['/events/[id]', () => f.event && `/events/${f.event}`],
  ['/secrets/[id]', () => f.secret && `/secrets/${f.secret}`],
  ['/apps/[id]', () => f.app && `/apps/${f.app}`],
  ['/heartbeats/[id]', () => f.heartbeat && `/heartbeats/${f.heartbeat}`],
  ['/n/[id]', () => f.node && `/n/${f.node}`],
  ['/nodes/[id]/history', () => f.node && `/nodes/${f.node}/history`],
  ['/debug/journey/[traceId]', () => f.trace && `/debug/journey/${f.trace}`],
];
const fixtureFor = (route) => {
  const hit = FIXTURES.find(([pattern]) => pattern === route);
  return hit ? hit[1]() : null;
};

const only = process.env.DEMO_CHECK_ONLY?.split(',').map((s) => s.trim());
const targets = allRoutes
  .filter((r) => !only || only.includes(r))
  .map((route) => {
    if (!route.includes('[')) return { route, url: route };
    const url = fixtureFor(route);
    return { route, url, skip: url ? null : 'no fixture seeded' };
  });

// ── Walk them ───────────────────────────────────────────────────────────────
// The browser cannot see everything. Some screens are filled by client/web's
// own server fetching the API, so a 500 there never reaches the page's network
// log — /runners rendered a tidy 176-char empty state while GET /api/runners
// returned 500 server-side, invisible to every browser-level assertion. Watch
// the API's log across the sweep and count what it recorded, so a failure the
// browser cannot witness is still reported rather than assumed absent.
const API_LOG = join(ROOT, 'demo/.run/serve-web.log');
const countApiErrors = async () => {
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(API_LOG, 'utf8').split('\n').filter((l) => l.includes('unhandled error')).length;
  } catch {
    return null; // not served by serve.sh — nothing to watch
  }
};
const apiErrorsBefore = await countApiErrors();

const browser = await chromium.launch();
const results = [];

async function visit({ route, url, skip }) {
  if (skip) return { route, state: 'SKIP', note: skip };

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const writes = [];
  const badResponses = [];

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  page.on('response', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.status() >= 400 && p.startsWith('/api/')) badResponses.push(`${r.status()} ${p}`);
  });

  let state = 'OK';
  let note = '';
  let chars = 0;
  try {
    const resp = await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = resp?.status() ?? 0;

    // Give the client a chance to hydrate and fill the region, but do not
    // hang the whole sweep on one screen.
    await page
      .waitForFunction(
        (min) => {
          const m = document.querySelector('main');
          return m && m.innerText.trim().length >= min;
        },
        THIN_CHARS,
        { timeout: 12_000 },
      )
      .catch(() => {});

    const probe = await page.evaluate(() => {
      const m = document.querySelector('main');
      return {
        hasMain: !!m,
        text: m ? m.innerText.trim() : '',
        pending: m ? m.innerHTML.includes('template id="B:') : false,
        path: location.pathname,
      };
    });
    chars = probe.text.length;

    if (status >= 400) {
      state = 'FAIL';
      note = `HTTP ${status}`;
    } else if (!probe.hasMain) {
      state = 'FAIL';
      note = 'no <main> element';
    } else if (probe.pending) {
      state = 'FAIL';
      note = 'unresolved React placeholder — client never hydrated';
    } else if (chars === 0) {
      state = 'FAIL';
      note = 'empty <main>';
    } else if (chars < THIN_CHARS) {
      state = 'THIN';
      note = `only ${chars} chars`;
    }

    // A redirect is not automatically a fault: the detail routes deliberately
    // become list-plus-selection (/notes/<id> → /notes?selected=<id>) and render
    // the record perfectly well. Report where it went AND how much it rendered,
    // so "redirect" never has to be taken on trust.
    if (probe.path !== url && state === 'OK') {
      state = 'REDIR';
      note = `→ ${probe.path} (${chars} chars)`;
    }
  } catch (err) {
    state = 'FAIL';
    note = String(err.message).split('\n')[0].slice(0, 120);
  }

  if (consoleErrors.length && state === 'OK') {
    state = 'FAIL';
    note = consoleErrors[0];
  }

  // A screen that renders a tidy empty state while its data call 500s is a
  // BROKEN screen, and the first version of this gate passed exactly that:
  // /runners scored OK on 176 chars of text while GET /api/runners returned
  // 500 twice. Rendering something is not the same as rendering the data.
  // 5xx fails outright; 401/403 is surfaced rather than swallowed, because the
  // read-only edge answers writes with 403 by design and the team surfaces
  // 401 for reasons that need a human decision, not an automatic verdict.
  const server5xx = badResponses.filter((b) => b.startsWith('5'));
  if (server5xx.length && state === 'OK') {
    state = 'FAIL';
    note = `renders, but its API failed: ${server5xx[0]}`;
  }

  await ctx.close();
  return { route, state, note, chars, consoleErrors, writes, badResponses };
}

// Serial on purpose: one brain, one API process, and a screen that is slow
// because the box is loaded is indistinguishable from one that is broken.
for (const t of targets) {
  const r = await visit(t);
  results.push(r);
  const mark = { OK: '✓', THIN: '·', SKIP: '–', REDIR: '→', FAIL: '✗' }[r.state];
  const detail = r.state === 'OK' ? `${r.chars} chars` : r.note;
  console.log(`${mark} ${r.route.padEnd(38)} ${detail}`);
}

await browser.close();

// ── Report ──────────────────────────────────────────────────────────────────
const by = (s) => results.filter((r) => r.state === s);
const fails = by('FAIL');
const thin = by('THIN');
const skipped = by('SKIP');
const writes = results.flatMap((r) => r.writes || []);

console.log('\n' + '─'.repeat(60));
console.log(
  `${results.length} routes — ${by('OK').length} ok · ${by('REDIR').length} redirect · ` +
    `${thin.length} thin · ${skipped.length} skipped · ${fails.length} failed`,
);

if (writes.length) {
  console.log(`\n⚠ non-GET requests fired (the demo is read-only): ${[...new Set(writes)].join(', ')}`);
}
if (skipped.length) {
  console.log('\nSKIPPED — no fixture seeded, so these were NOT covered:');
  for (const r of skipped) console.log(`  ${r.route}`);
}
if (thin.length) {
  console.log('\nTHIN — renders, but nearly nothing. Decide per screen: seed it, or accept an honest empty state.');
  for (const r of thin) console.log(`  ${r.route.padEnd(38)} ${r.note}`);
}

// Auth failures on screens that still rendered. Not an automatic verdict —
// but never silent either, because "the page looked fine" is how a demo ships
// with a dead surface behind it.
const authIssues = results.filter(
  (r) => r.state !== 'FAIL' && (r.badResponses || []).some((b) => b.startsWith('401') || b.startsWith('403')),
);
if (authIssues.length) {
  console.log('\nAUTH — rendered, but an API call was refused:');
  for (const r of authIssues) {
    console.log(`  ${r.route.padEnd(38)} ${[...new Set(r.badResponses)].slice(0, 3).join(', ')}`);
  }
}
const apiErrorsAfter = await countApiErrors();
if (process.env.DEMO_CHECK_DEBUG) console.log(`[debug] api log ${API_LOG} before=${apiErrorsBefore} after=${apiErrorsAfter}`);
if (apiErrorsBefore !== null && apiErrorsAfter > apiErrorsBefore) {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(API_LOG, 'utf8')
    .split('\n')
    .filter((l) => l.includes('unhandled error'))
    .slice(apiErrorsBefore);
  const paths = [...new Set(lines.map((l) => (l.match(/unhandled error on \w+ ([^:]+)/) || [])[1]).filter(Boolean))];
  console.log(
    `\nSERVER-SIDE API ERRORS — ${apiErrorsAfter - apiErrorsBefore} unhandled error(s) logged during this sweep.`,
  );
  console.log('These do not reach the browser, so no screen above can be trusted to have shown them:');
  for (const p of paths) console.log(`  ${p}`);
}

if (fails.length) {
  console.log('\nFAILED:');
  for (const r of fails) {
    console.log(`  ${r.route.padEnd(38)} ${r.note}`);
    if (r.badResponses?.length) console.log(`      api: ${[...new Set(r.badResponses)].slice(0, 4).join(', ')}`);
  }
  console.log('\n✗ coverage gate FAILED');
  process.exit(1);
}
// Never print an unqualified tick over errors that were logged. A gate that
// says ✓ while the server was throwing is how you learn to stop reading it.
const serverSideErrors = apiErrorsBefore !== null ? apiErrorsAfter - apiErrorsBefore : 0;
if (serverSideErrors > 0) {
  console.log(`\n✓ every covered route renders — but the API logged ${serverSideErrors} error(s) above. Read those.`);
} else {
  console.log('\n✓ every covered route renders');
}
