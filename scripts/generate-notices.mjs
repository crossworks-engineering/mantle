#!/usr/bin/env node
// Generate THIRD-PARTY-NOTICES.md from the installed production dependency tree.
//
// Mantle ships under a dual license (FSL-1.1-MIT + Commercial — see LICENSE.md /
// LICENSE-COMMERCIAL.md). This script collects the licenses of every *production*
// dependency so the distributed product is fully attributed, as those upstream
// licenses (MIT, Apache-2.0, BSD, ISC, LGPL, …) require.
//
// Source of truth is `pnpm licenses list --prod --json`, enriched with the verbatim
// LICENSE text read straight from each package's install directory. Re-run after any
// dependency change:  pnpm licenses:notices
//
// Usage: node scripts/generate-notices.mjs [--out <path>] [--dev]

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const includeDev = argv.includes('--dev');
const outIdx = argv.indexOf('--out');
const outPath = outIdx !== -1 ? argv[outIdx + 1] : join(repoRoot, 'THIRD-PARTY-NOTICES.md');

/** Run `pnpm licenses list` and parse its JSON, grouped by license id. */
function collectLicenses() {
  const args = ['licenses', 'list', '--json'];
  if (!includeDev) args.push('--prod');
  const raw = execFileSync('pnpm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

const LICENSE_FILE_RE = /^(LICEN[SC]E|COPYING|NOTICE|UNLICENSE)(\..*)?$/i;

// Canonical SPDX license texts bundled under scripts/license-texts/, used as a
// fallback when a package ships no license file of its own. Important for
// notice-required / copyleft licenses (e.g. LGPL) where the full text must travel
// with the distribution. Some SPDX ids alias onto a single bundled body.
const canonicalTextDir = join(repoRoot, 'scripts', 'license-texts');
const CANONICAL_ALIASES = {
  'lgpl-3.0': 'LGPL-3.0-or-later',
  'lgpl-3.0-only': 'LGPL-3.0-or-later',
  'lgpl-3.0-or-later': 'LGPL-3.0-or-later',
};
const canonicalCache = new Map();

function readCanonicalFile(id) {
  if (canonicalCache.has(id)) return canonicalCache.get(id);
  let text = null;
  try {
    text = readFileSync(join(canonicalTextDir, `${id}.txt`), 'utf8').trim() || null;
  } catch {
    // no canonical text on disk for this licence id — leave null
  }
  canonicalCache.set(id, text);
  return text;
}

/** Resolve a (possibly composite, e.g. "MIT AND ISC") SPDX id to bundled canonical
 *  text. For AND-expressions, concatenate every part we have; for OR, take the first. */
function canonicalLicenseText(licenseId) {
  const raw = String(licenseId)
    .replace(/^\(|\)$/g, '')
    .trim();
  const isAnd = /\bAND\b/i.test(raw);
  const parts = raw.split(/\s+(?:AND|OR)\s+/i).map((p) => p.trim());
  const resolved = parts
    .map((p) => CANONICAL_ALIASES[p.toLowerCase()] || p)
    .map((id) => ({ id, text: readCanonicalFile(id) }))
    .filter((r) => r.text);
  if (!resolved.length) return null;
  if (isAnd && resolved.length > 1) {
    return {
      label: resolved.map((r) => r.id).join(' AND '),
      text: resolved.map((r) => `=== ${r.id} ===\n\n${r.text}`).join('\n\n'),
    };
  }
  return { label: resolved[0].id, text: resolved[0].text };
}

/** Best-effort read of the verbatim license text from a package's install dir. */
function readLicenseText(pkgPath) {
  if (!pkgPath) return null;
  let entries;
  try {
    entries = readdirSync(pkgPath);
  } catch {
    return null;
  }
  // Prefer an actual LICENSE/COPYING file; fall back to none.
  const candidates = entries
    .filter((f) => LICENSE_FILE_RE.test(f))
    .sort((a, b) => {
      // Plain "LICENSE" before "LICENSE-MIT" before "NOTICE", etc.
      const score = (n) => (/^licen[sc]e(\.|$)/i.test(n) ? 0 : /^copying/i.test(n) ? 1 : 2);
      return score(a) - score(b) || a.length - b.length;
    });
  for (const file of candidates) {
    const full = join(pkgPath, file);
    try {
      if (!statSync(full).isFile()) continue;
      const text = readFileSync(full, 'utf8').trim();
      if (text) return { file, text };
    } catch {
      /* keep trying */
    }
  }
  return null;
}

/** Escape a value for safe use inside a Markdown table cell. */
function td(s) {
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ')
    .trim();
}

function authorName(author) {
  if (!author) return '';
  if (typeof author === 'string') return author;
  if (typeof author === 'object') return author.name || '';
  return '';
}

function main() {
  const grouped = collectLicenses();
  const licenseIds = Object.keys(grouped).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  // Flatten to a sorted, de-duplicated package list while remembering the license id.
  const packages = [];
  let total = 0;
  for (const licenseId of licenseIds) {
    for (const pkg of grouped[licenseId]) {
      packages.push({ ...pkg, licenseId });
      total += 1;
    }
  }

  const now = new Date().toISOString().slice(0, 10);
  const scope = includeDev ? 'all (production + development)' : 'production';

  const out = [];
  out.push('# Third-Party Notices');
  out.push('');
  out.push(
    'Mantle is distributed by **Cross Works Engineering (Pty) Ltd** under a dual license — ' +
      'the Functional Source License 1.1 (MIT future) for public use ([`LICENSE.md`](./LICENSE.md)) ' +
      'and a separate Commercial License for embedded/competing use ([`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md)). ' +
      'See [`LICENSING.md`](./LICENSING.md) for the plain-language explainer.',
  );
  out.push('');
  out.push(
    'The Mantle product incorporates the third-party open-source software listed below. ' +
      'Each component remains under its own license; those licenses are reproduced verbatim ' +
      'here to satisfy their attribution and notice requirements. Nothing in Mantle’s own ' +
      'license alters the terms that apply to these components.',
  );
  out.push('');
  out.push(
    `> Generated by \`scripts/generate-notices.mjs\` on ${now} — scope: ${scope} dependencies. ` +
      'Do not edit by hand; re-run `pnpm licenses:notices` after changing dependencies.',
  );
  out.push('');

  // ---- Summary table -------------------------------------------------------
  out.push('## Summary');
  out.push('');
  out.push(
    `A total of **${total}** ${scope} packages across **${licenseIds.length}** license types.`,
  );
  out.push('');
  out.push('| License | Packages |');
  out.push('| --- | ---: |');
  for (const id of licenseIds) {
    out.push(`| ${td(id)} | ${grouped[id].length} |`);
  }
  out.push('');
  out.push(
    '> **Note on copyleft components.** A small number of dependencies are licensed under the ' +
      'LGPL (e.g. `libheif-js`, `@img/sharp-libvips-*`). Mantle uses these as separate, ' +
      'dynamically-loaded libraries (WebAssembly / prebuilt native binaries) without modification; ' +
      'their LGPL terms are satisfied by this notice and by shipping them as replaceable, ' +
      'independently-licensed modules. Dual-licensed components (e.g. `jszip` MIT-or-GPL, ' +
      '`@zone-eu/mailsplit` MIT-or-EUPL) are used under their permissive (MIT) option.',
  );
  out.push('');

  // ---- Per-package detail --------------------------------------------------
  out.push('## Components');
  out.push('');

  // Stable, human-friendly ordering: by license id, then package name.
  packages.sort(
    (a, b) =>
      a.licenseId.toLowerCase().localeCompare(b.licenseId.toLowerCase()) ||
      a.name.localeCompare(b.name),
  );

  let currentLicense = null;
  let missingText = 0;
  for (const pkg of packages) {
    if (pkg.licenseId !== currentLicense) {
      currentLicense = pkg.licenseId;
      out.push(`### ${currentLicense}`);
      out.push('');
    }
    const versions = Array.isArray(pkg.versions) ? pkg.versions.join(', ') : '';
    const author = authorName(pkg.author);
    const home = pkg.homepage ? ` — <${pkg.homepage}>` : '';
    out.push(`#### ${pkg.name}${versions ? ` (${versions})` : ''}`);
    out.push('');
    const meta = [];
    if (author) meta.push(`**Author:** ${author}`);
    meta.push(`**License:** ${pkg.licenseId}`);
    if (pkg.homepage) meta.push(`**Homepage:** ${pkg.homepage}`);
    out.push(meta.join(' · '));
    out.push('');

    const fence = (body) =>
      // Use a 4-backtick fence and break up any 3+ backtick run inside the body so a
      // license that itself contains a code fence can't escape the block.
      ['````', body.replace(/`{3,}/g, (m) => m.split('').join('​')), '````'];

    const lic = readLicenseText(pkg.paths && pkg.paths[0]);
    if (lic) {
      out.push(
        '<details><summary>License text</summary>',
        '',
        ...fence(lic.text),
        '',
        '</details>',
      );
    } else {
      const canonical = canonicalLicenseText(pkg.licenseId);
      if (canonical) {
        out.push(
          `<details><summary>License text — standard ${canonical.label} text (no per-package file bundled)</summary>`,
          '',
          ...fence(canonical.text),
          '',
          '</details>',
        );
      } else {
        missingText += 1;
        out.push(
          `_No bundled license file found in the package; refer to the \`${pkg.licenseId}\` ` +
            `standard license text${home ? ' and the project homepage' : ''}._${home}`,
        );
      }
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  const remainder =
    missingText > 0
      ? ` For ${missingText} component(s) no license file was bundled and no canonical text is on ` +
        'file; the SPDX identifier shown above governs.'
      : '';
  out.push(
    `_${total} components attributed; license text embedded for ${total - missingText} ` +
      "(each package's own file where present, otherwise the standard SPDX text)." +
      `${remainder}_`,
  );
  out.push('');

  writeFileSync(outPath, out.join('\n'), 'utf8');
  process.stderr.write(
    `Wrote ${outPath} — ${total} ${scope} components, ${licenseIds.length} license types ` +
      `(${total - missingText} with embedded text).\n`,
  );
}

main();
