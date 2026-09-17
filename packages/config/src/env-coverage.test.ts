/**
 * Every environment variable is either documented or declared internal.
 *
 * `@mantle/config` gave the tree ONE list of known names, which fixed the "is
 * this var real?" question. It did nothing about the second one — "how do I
 * find out this dial exists?" — and that gap grew quietly: the 2026-09-02 audit
 * measured 85 of 119 names absent from `.env.example`, and by 2026-09-03 it was
 * 99 of 133. Every name added since had made it worse, because nothing failed.
 *
 * So: a name is covered when it appears in `.env.example` (commented out is
 * fine — that is how an optional dial is shown) or in `INTERNAL_ENV` with a
 * reason. The reason matters more than the exemption; "platform" and "script"
 * are the only two honest ones, and anything an operator might want to change
 * on a running box does not qualify for either.
 *
 * The reverse direction is checked too. `.env.example` naming something the
 * code cannot read is the older, quieter failure: an operator sets it, nothing
 * happens, and the file is what told them to.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_ENV } from './index';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(join(repoRoot, 'packages/config/src/index.ts'), 'utf8');
const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');

/** The union members of KnownEnvName, read out of this package's own source.
 *  Types are erased at runtime, so the list has to come from the text. */
const KNOWN: string[] = (() => {
  const start = source.indexOf('export type KnownEnvName =');
  const block = source.slice(start, source.indexOf(';\n', start));
  return [...new Set(block.match(/'([A-Z0-9_]+)'/g)!.map((s) => s.slice(1, -1)))].sort();
})();

/** Names `.env.example` assigns, commented out or not. `# NAME=` counts: that
 *  is exactly how the file shows an optional dial and its default. */
const DOCUMENTED = new Set(
  [...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
);

/** Legacy names still honoured by `env()`. Documented, deliberately not in
 *  KnownEnvName — the canonical name is. */
const ALIASES = new Set(
  [...source.matchAll(/^\s*[A-Z0-9_]+:\s*'([A-Z][A-Z0-9_]*)',$/gm)].map((m) => m[1]!),
);

/**
 * Documented, and read by the PLATFORM rather than by TypeScript: compose
 * substitutes them, Caddy expands them, or an install script consumes them.
 * They belong in `.env.example` — an operator really does set them — and they
 * must never be in KnownEnvName, because no `env()` call can reach them.
 *
 * Each is asserted below to be referenced somewhere outside the TS tree, so an
 * entry cannot outlive the thing that reads it. That is the whole difference
 * between this list and a blanket prefix skip, which is what it replaced.
 */
const PLATFORM_READS: Record<string, string> = {
  COMPOSE_PROFILES: 'docker compose selects optional services with it',
  MANTLE_MAX_BODY_SIZE: 'expanded in infra/caddy/Caddyfile as the proxy body ceiling',
  MANTLE_SANDBOXES_HOST_DIR: 'a HOST path handed to the Docker daemon as a bind source',
};

describe('env coverage', () => {
  it('found both lists (positive control)', () => {
    // A regex that silently matched nothing would make every assertion below
    // pass for the wrong reason.
    expect(KNOWN.length).toBeGreaterThan(100);
    expect(DOCUMENTED.size).toBeGreaterThan(50);
    expect(KNOWN).toContain('DATABASE_URL');
    expect(DOCUMENTED.has('DATABASE_URL')).toBe(true);
  });

  it('documents every known variable, or declares it internal with a reason', () => {
    const undocumented = KNOWN.filter((n) => !DOCUMENTED.has(n) && !(n in INTERNAL_ENV));
    expect(
      undocumented,
      'these names are readable by the code but an operator cannot discover them. ' +
        'Add each to .env.example with its default (commented out is fine), or — only ' +
        'if compose/the image sets it, or it is an argument to a one-off script — to ' +
        'INTERNAL_ENV in packages/config/src/index.ts with the reason.',
    ).toEqual([]);
  });

  it('never exempts a name that is ALSO documented', () => {
    // Both lists is a contradiction: the file offers it, the exemption says
    // nobody sets it. One of the two is wrong and the reader cannot tell which.
    const both = Object.keys(INTERNAL_ENV).filter((n) => DOCUMENTED.has(n));
    expect(both).toEqual([]);
  });

  it('gives every exemption one of the two honest reasons', () => {
    for (const [name, reason] of Object.entries(INTERNAL_ENV)) {
      expect(KNOWN, `INTERNAL_ENV names unknown variable ${name}`).toContain(name);
      expect(
        reason,
        `${name}: an exemption reason must start "platform:" (compose/image sets it) ` +
          'or "script:" (an argument to a one-off CLI). Anything an operator might ' +
          'change on a running box belongs in .env.example instead.',
      ).toMatch(/^(platform|script): \S/);
    }
  });

  it('assigns nothing in .env.example that the code cannot read', () => {
    // The quieter failure: an operator sets a name the file told them about,
    // nothing happens, and there is no error anywhere to explain it.
    const known = new Set(KNOWN);
    const orphans = [...DOCUMENTED].filter(
      (n) => !known.has(n) && !ALIASES.has(n) && !(n in PLATFORM_READS),
    );
    expect(
      orphans,
      'these are assigned in .env.example but nothing reads them — add them to ' +
        'KnownEnvName, or to PLATFORM_READS if compose/Caddy/an install script is ' +
        'what consumes them, or delete the line. (This caught OPENAI_API_KEY, which ' +
        'no longer had a reader anywhere: provider keys moved to the vault.)',
    ).toEqual([]);
  });

  it('keeps every PLATFORM_READS entry pointed at something real', () => {
    // The exemption is only honest while the consumer exists. A stale entry
    // here is the same failure the orphan check above exists to catch, just
    // one level up.
    const consumers = [
      readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8'),
      readFileSync(join(repoRoot, 'infra/caddy/Caddyfile'), 'utf8'),
      readFileSync(join(repoRoot, 'scripts/install.sh'), 'utf8'),
    ].join('\n');
    for (const [name, why] of Object.entries(PLATFORM_READS)) {
      expect(consumers, `${name} is exempted as "${why}" but nothing references it`).toContain(
        name,
      );
    }
  });
});
