/**
 * Flags and env from one place (docs/configuration.md "Flags and
 * env"). Four patterns are counted, and outside its named list each count
 * is 0:
 *
 *  - a raw `process.env.X` / `process.env[...]` read (the ESLint
 *    no-restricted-syntax rule already refused most; this count names every
 *    file that still reads raw and why): read through @mantle/config;
 *  - a hand parse of an env value: `Number(env(...))`, `parseInt(...)`, a
 *    value compared with a flag word (`=== '1'`, `!== 'false'`), a flag
 *    word regex tested on it, or the `?.trim().toLowerCase()` flag dialect
 *    (57 number readers and 19 flag readers in seven dialects before): read a
 *    registered number with `envNum`, a switch with `feature`, or parse with
 *    `parseFlag` / `parseNumber` (packages/config/src/parse.ts);
 *  - an `isXEnabled` definition (7 before, each parsing its own variable):
 *    register the switch in FEATURES and read `feature(name)`;
 *  - a profile boolean compared with its default by hand
 *    (`prefs.shareNeat !== false`, 29 before): read it with `profileFlag`
 *    or `feature(name, { prefs })`, the default lives in PROFILE_FLAGS.
 *
 * scripts/arch-scoreboard.ts pins each number; env-flags.test.ts holds each
 * list to exactly the files that still have the pattern. A key ending in `/`
 * names a folder. The rule is the editor's early warning: it flags a file
 * outside a list.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoPathOf, stripComments } from './arch-counts.mjs';

/** @typedef {Record<string, string>} AllowList file or folder/ -> why */

/** @type {AllowList} */
export const RAW_ENV_ALLOWED = {
  'packages/config/src/index.ts': 'env() and envDynamic() themselves: the one reader',
  'packages/client-types/src/turn-streaming.ts':
    'the published, browser-safe turn streaming readers (the brain reads feature("turnStreaming")); the server one honours the legacy alias as env() does',
  'packages/client-types/src/version.ts':
    'the build identity the frontend build inlines at compile time (NEXT_PUBLIC_*)',
  'packages/app-build/src/runtime-exports.ts':
    'a package published to npm, which cannot depend on the private @mantle/config',
  'server/web/server/env.ts':
    'the .env file loader: it writes process.env before anything reads it',
  'server/web/server/main.ts':
    'the boot bridge: copies MANTLE_GIT_SHA / MANTLE_BUILD_TIME into the NEXT_PUBLIC_* names the version module reads',
  'server/sandboxd/':
    'a standalone image with no workspace dependencies; its own config block at the top of main.ts',
  'scripts/': 'repo CLIs run from a bare checkout (node, no workspace packages)',
  'packages/app-build/scripts/': 'the app runtime build script, run by hand or by the image build',
};

/** @type {AllowList} */
export const HAND_PARSE_ALLOWED = {
  'server/sandboxd/':
    'a standalone image with no workspace dependencies; its own config block at the top of main.ts',
  'scripts/': 'repo CLIs run from a bare checkout (node, no workspace packages)',
};

/** @type {AllowList} */
export const IS_ENABLED_ALLOWED = {
  'packages/client-types/src/turn-streaming.ts':
    'the published contract (@crossworks/client-types): isTurnStreamingEnabled stays for the client; the brain reads feature("turnStreaming")',
  'packages/content-core/src/profile-projections.ts':
    'the published contract (@crossworks/content-core): three one-line readers over profileFlag, kept for the client',
  'server/web/lib/mcp-oauth.ts':
    "isRemoteMcpEnabled resolves the box's sole owner first, then reads feature('remoteMcp', { prefs })",
};

/** @type {AllowList} */
export const PREF_DEFAULT_ALLOWED = {};

const ENV_CALL = String.raw`(?:\benv|\benvDynamic)\(\s*[^()]*\)`;
const RAW = String.raw`\bprocess\.env(?:\.[A-Za-z_]\w*|\[[^\]]*\])`;
const SOURCE = `(?:${ENV_CALL}|${RAW})`;
const FLAG_WORD = String.raw`['"\`](?:0|1|true|false|yes|no|on|off)['"\`]`;

/** Raw `process.env` member reads in `code` (comments blanked). A quoted
 *  `'process.env.NODE_ENV'` (a bundler define key) is not a read. */
export function rawEnvReads(code) {
  return (code.match(/(?<!['"`])\bprocess\.env(?:\.[A-Za-z_]\w*|\[)/g) ?? []).length;
}

/** Hand parses of an env value in `code`. */
export function handEnvParses(code) {
  let n = 0;
  const count = (re) => {
    n += (code.match(re) ?? []).length;
  };
  // A number: Number(env(...)), parseInt(process.env.X), +env(...).
  count(
    new RegExp(
      String.raw`\b(?:Number(?:\.parseInt|\.parseFloat)?|parseInt|parseFloat)\(\s*\(?\s*` + SOURCE,
      'g',
    ),
  );
  count(new RegExp(String.raw`(?<![\w)\]])\+\s*` + SOURCE, 'g'));
  // A flag: compared with a flag word, or a flag word regex tested on it.
  count(
    new RegExp(
      SOURCE + String.raw`(?:\s*\?\?\s*['"\`][^'"\`]*['"\`])?\s*[!=]==\s*` + FLAG_WORD,
      'g',
    ),
  );
  count(
    new RegExp(
      String.raw`/\^\(?[^/\n]*\b(?:true|false|on|off|yes|no)\b[^/\n]*\$/i?\.test\(\s*` + SOURCE,
      'g',
    ),
  );
  // The `env('X')?.trim().toLowerCase()` flag dialect.
  count(new RegExp(SOURCE + String.raw`\?\.trim\(\)\.toLowerCase\(\)`, 'g'));
  // Two steps: `const raw = env('X')` then `Number(raw)`.
  for (const m of code.matchAll(
    new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*` + SOURCE, 'g'),
  )) {
    const v = m[1];
    const later = code.slice(m.index + m[0].length);
    n += (
      later.match(new RegExp(String.raw`\b(?:Number|parseInt|parseFloat)\(\s*${v}\b`, 'g')) ?? []
    ).length;
  }
  return n;
}

/** `isXEnabled` definitions in `code`. */
export function isEnabledDefs(code) {
  return (
    code.match(/\bfunction\s+is[A-Z]\w*Enabled\b|\b(?:const|let)\s+is[A-Z]\w*Enabled\s*=/g) ?? []
  ).length;
}

/** The profile boolean keys: PROFILE_FLAGS in client-types. */
export const PROFILE_FLAG_KEYS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, '../packages/client-types/src/profile-flags.ts'), 'utf8');
  const start = text.indexOf('export const PROFILE_FLAGS = {');
  const block = text.slice(start, text.indexOf('} as const', start));
  return [...block.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
})();

/** Profile booleans compared with their default by hand in `code`. */
export function prefDefaultChecks(code) {
  const keys = PROFILE_FLAG_KEYS.join('|');
  return (code.match(new RegExp(String.raw`\.(?:${keys})\s*[!=]==\s*(?:true|false)\b`, 'g')) ?? [])
    .length;
}

/** Each pattern: its counter and its named list. */
export const ENV_PATTERNS = {
  rawRead: { count: rawEnvReads, allowed: RAW_ENV_ALLOWED },
  handParse: { count: handEnvParses, allowed: HAND_PARSE_ALLOWED },
  isEnabledDef: { count: isEnabledDefs, allowed: IS_ENABLED_ALLOWED },
  prefDefault: { count: prefDefaultChecks, allowed: PREF_DEFAULT_ALLOWED },
};

/** The list entry that names `path` (the file, or a folder holding it). */
export function allowedBy(allowed, path) {
  if (Object.hasOwn(allowed, path)) return path;
  return Object.keys(allowed).find((k) => k.endsWith('/') && path.startsWith(k)) ?? null;
}

const MESSAGES = {
  rawRead:
    'Read the environment through @mantle/config (env, envNum, feature, envDynamic), not process.env.X. A file that must read raw is named in eslint-rules/env-flags.mjs.',
  handParse:
    "Do not parse an env value by hand: register a number in ENV_NUMBERS and read envNum('NAME'), a switch in FEATURES and read feature('name'), or parse with parseFlag / parseNumber (@mantle/config).",
  isEnabledDef:
    "Register the switch in FEATURES (packages/config/src/features.ts) and read feature('name'), not a new isXEnabled().",
  prefDefault:
    "Read a profile boolean with profileFlag(prefs, 'key') or feature('name', { prefs }); its default lives in PROFILE_FLAGS.",
};

function ruleFor(key) {
  const { count, allowed } = ENV_PATTERNS[key];
  return {
    meta: {
      type: 'problem',
      docs: { description: `flags and env from one place (A10 #11): ${key}` },
      messages: { over: MESSAGES[key] },
      schema: [],
    },
    create(context) {
      const path = repoPathOf(context.filename);
      if (!path || allowedBy(allowed, path)) return {};
      return {
        Program(node) {
          if (count(stripComments(context.sourceCode.getText())) > 0) {
            context.report({ node, messageId: 'over' });
          }
        },
      };
    },
  };
}

export const rules = Object.fromEntries(Object.keys(ENV_PATTERNS).map((k) => [k, ruleFor(k)]));

export default { rules };
