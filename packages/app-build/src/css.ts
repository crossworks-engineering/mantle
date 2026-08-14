/**
 * Per-app Tailwind CSS compile. The host stylesheet only contains utilities
 * used somewhere in the REPO's scanned sources, but app source is authored at
 * runtime — any class the repo never uses (grid-cols-7, arbitrary values, …)
 * was simply missing and the app rendered partially unstyled. This compiles a
 * small stylesheet from the app's OWN candidates (its virtual source tree plus
 * the kit sources), emitted as utilities only:
 *
 *   - Tailwind's default theme is imported `theme(reference)` — resolvable,
 *     never emitted (the host sheet already ships tokens + preflight).
 *   - The shadcn-style token mapping (`--color-primary: var(--primary)`, …) is
 *     extracted from share-ui's generated themes.css `@theme inline` block, so
 *     there is no second token list to drift.
 *
 * The result rides next to the JS bundle (BuildRef.css) and is inlined into
 * the sandbox srcdoc after the host styles, closing the gap on every surface
 * (owner preview, /s shares, the team hub) at once.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { compile } from 'tailwindcss';
import { KIT } from './kit';
import type { AppSource } from './index';

const require = createRequire(import.meta.url);

/** The generated `@theme inline { … }` mapping from share-ui, re-emitted as a
 *  reference block (definitions only, no output). Cached per process — the
 *  file is static for the lifetime of the server. */
let themeMapCache: string | null = null;
function themeMapReference(): string {
  if (themeMapCache !== null) return themeMapCache;
  const file = require.resolve('@mantle/share-ui/styles/themes.css');
  const text = fs.readFileSync(file, 'utf8');
  const marker = '@theme inline {';
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`no '@theme inline' block in ${file}`);
  let i = start + marker.length;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`unbalanced '@theme inline' block in ${file}`);
  const body = text.slice(start + marker.length, i - 1);
  themeMapCache = `@theme inline reference {${body}}`;
  return themeMapCache;
}

function inputCss(): string {
  return [
    '@layer theme, base, components, utilities;',
    "@import 'tailwindcss/theme.css' layer(theme) theme(reference);",
    "@import 'tailwindcss/utilities.css' layer(utilities);",
    '@custom-variant dark (&:is(.dark *));',
    themeMapReference(),
  ].join('\n');
}

function extensionOf(key: string): string {
  const ext = path.posix.extname(key).slice(1);
  return ext || 'tsx';
}

/**
 * Compile the app's utility CSS from its source tree + the kit sources.
 * Returns minified CSS. Throws on an internal compile failure — the caller
 * (buildApp) degrades that to a warning, never a red build: missing CSS means
 * "host stylesheet only", exactly the pre-feature behaviour.
 */
export async function buildAppCss(source: AppSource): Promise<string> {
  // oxide is a napi CJS package — require keeps the interop unambiguous.
  const { Scanner } = require('@tailwindcss/oxide') as {
    Scanner: new (opts: object) => {
      scanFiles(files: { content: string; extension: string }[]): string[];
    };
  };
  const scanner = new Scanner({});
  const candidates = scanner.scanFiles([
    ...Object.entries(source.files).map(([key, content]) => ({
      content,
      extension: extensionOf(key),
    })),
    // Kit components render inside the same iframe; including their classes
    // makes the app stylesheet self-sufficient even where the host sheet was
    // built without the kit @source.
    ...Object.values(KIT).map((content) => ({ content, extension: 'tsx' })),
  ]);

  const compiler = await compile(inputCss(), {
    base: path.dirname(fileURLToPath(import.meta.url)),
    loadStylesheet: async (id: string, base: string) => {
      const file = id.startsWith('.') ? path.resolve(base, id) : require.resolve(id);
      return { base: path.dirname(file), content: fs.readFileSync(file, 'utf8'), path: file };
    },
  });
  const css = compiler.build(candidates);
  const min = await esbuild.transform(css, { loader: 'css', minify: true });
  return min.code;
}
