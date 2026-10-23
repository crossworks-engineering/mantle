/**
 * The render harness: open a template with a data file in headless Chromium,
 * the way an agent's render tool will, and save what came out.
 *
 *   node scripts/render.ts samples/flow-ingest.json [more.json ...] [--out samples/out]
 *   node scripts/render.ts --all                    every samples/*.json
 *
 * Chromium: a local Chrome (--chrome <path>, or the usual macOS and Linux
 * paths), or a running browserless service (--ws ws://host:3000, the
 * same one `mantle_browser` runs on a brain).
 *
 * For each data file it writes <name>.svg (the export), <name>.png (that SVG
 * drawn through <img> at 2x, as a page shows it) and <name>.report.json,
 * and fails (exit 1) on a data error, a console error, any network request
 * (a template must work offline), or an export that is not static.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer, { type Browser } from 'puppeteer-core';
import { buildCanvas, checkStaticSvg, isTemplateName } from '../src/index.ts';
import { messageOf } from '../src/runtime/validate.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const WITH_VALUE = ['--out', '--chrome', '--ws'];
const chromeFlag = flag('--chrome');
const wsFlag = flag('--ws');
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1]! : path.join(ROOT, 'samples/out'));
const files = args.includes('--all')
  ? readdirSync(path.join(ROOT, 'samples'))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(ROOT, 'samples', f))
  : args
      .filter((a, i) => !a.startsWith('--') && !WITH_VALUE.includes(args[i - 1] ?? ''))
      .map((a) => path.resolve(a));
if (!files.length) {
  console.error('usage: node scripts/render.ts <data.json ...> [--out dir] | --all');
  process.exit(2);
}

const runtimeFile = path.join(ROOT, 'dist/diagram-runtime.js');
if (!existsSync(runtimeFile))
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.ts')], { stdio: 'inherit' });
const runtime = readFileSync(runtimeFile, 'utf8');

function chromePath(): string {
  const c = [
    chromeFlag,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((p): p is string => !!p);
  const hit = c.find((p) => existsSync(p));
  if (!hit)
    throw new Error(
      'no Chrome found: pass --chrome <path>, or --ws <endpoint> for a browserless service',
    );
  return hit;
}

async function open(): Promise<Browser> {
  if (wsFlag) return puppeteer.connect({ browserWSEndpoint: wsFlag });
  return puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
}

type Report = {
  file: string;
  template: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  consoleErrors: string[];
  network: string[];
  staticProblems: string[];
  stats: Record<string, number>;
  size?: { width: number; height: number };
  ms: number;
};

const browser = await open();
mkdirSync(outDir, { recursive: true });
let failed = 0;
try {
  for (const file of files) {
    const started = Date.now();
    const name = path.basename(file, '.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as { template?: string };
    const template = data.template ?? '';
    const report: Report = {
      file: path.relative(ROOT, file),
      template,
      ok: false,
      errors: [],
      warnings: [],
      consoleErrors: [],
      network: [],
      staticProblems: [],
      stats: {},
      ms: 0,
    };
    if (!isTemplateName(template)) {
      report.errors.push(`template: '${template}' is not a template (set "template" in the data).`);
    } else {
      const html = buildCanvas({ template, data, runtime });
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      // Offline by construction: every request is refused and reported.
      page.on('request', (r) => {
        const u = r.url();
        if (u.startsWith('data:') || u === 'about:blank') return void r.continue();
        report.network.push(u);
        void r.abort();
      });
      page.on('console', (msg) => {
        if (msg.type() === 'error') report.consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => {
        const text = messageOf(err);
        // A data error is thrown on purpose (the frame reports it); it is
        // already in report.errors.
        if (!text.startsWith('diagram:')) report.consoleErrors.push(text);
      });
      await page.setViewport({ width: 1600, height: 1000 });
      await page.setContent(html, { waitUntil: 'load' });
      const outcome = await page.evaluate(async () => {
        const o = await window.diagram!.ready;
        return o.ok
          ? {
              ok: true as const,
              warnings: o.warnings,
              stats: o.stats,
              svg: window.diagram!.exportSvg(),
              width: o.width,
              height: o.height,
            }
          : { ok: false as const, errors: o.errors, warnings: o.warnings };
      });
      report.warnings = outcome.warnings;
      if (!outcome.ok) report.errors = outcome.errors;
      else {
        report.stats = outcome.stats;
        report.size = { width: outcome.width, height: outcome.height };
        report.staticProblems = checkStaticSvg(outcome.svg);
        writeFileSync(path.join(outDir, `${name}.svg`), outcome.svg);
        // The PNG is the EXPORT drawn through <img>, as a page shows it.
        const shot = await browser.newPage();
        await shot.setViewport({
          width: Math.ceil(outcome.width),
          height: Math.ceil(outcome.height),
          deviceScaleFactor: 2,
        });
        const b64 = Buffer.from(outcome.svg).toString('base64');
        await shot.setContent(
          `<html><body style="margin:0"><img id="d" style="display:block" src="data:image/svg+xml;base64,${b64}"></body></html>`,
          { waitUntil: 'load' },
        );
        const img = await shot.$('#d');
        await img!.screenshot({ path: path.join(outDir, `${name}.png`) as `${string}.png` });
        await shot.close();
      }
      await page.close();
    }
    report.ok =
      !report.errors.length &&
      !report.consoleErrors.length &&
      !report.network.length &&
      !report.staticProblems.length;
    report.ms = Date.now() - started;
    // The time is printed, not stored, so a report only changes when the result does.
    const { ms: _ms, ...stored } = report;
    writeFileSync(path.join(outDir, `${name}.report.json`), JSON.stringify(stored, null, 2) + '\n');
    if (!report.ok) failed++;
    const tag = report.ok ? 'ok  ' : 'FAIL';
    console.log(
      `${tag} ${report.file} -> ${template} ${report.size ? `${report.size.width}x${report.size.height}` : ''} ${report.ms}ms`,
    );
    for (const e of report.errors) console.log(`     error: ${e}`);
    for (const e of report.consoleErrors) console.log(`     console: ${e}`);
    for (const e of report.network) console.log(`     network: ${e}`);
    for (const e of report.staticProblems) console.log(`     export: ${e}`);
    for (const w of report.warnings) console.log(`     warning: ${w}`);
  }
} finally {
  await (wsFlag ? browser.disconnect() : browser.close());
}
process.exit(failed ? 1 : 0);
