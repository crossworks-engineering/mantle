/**
 * The CI floor for destructive and confirm-gated builtins.
 *
 * Phase 1 of the tool-coverage work (v0.232.154-156) put a behavioural test
 * in front of every tool that deletes, revokes, or sends something outward.
 * That gain is only permanent if the NEXT such tool cannot land without one,
 * which is what this sweep enforces. It also pins two invariants that held
 * for every tool checked during that work and were enforced by nothing:
 *
 *  1. A destructive tool never appears in its own package's auto-grant list.
 *     The confirm gate stops an unattended call; the auto-grant exclusion
 *     stops a conversational agent from holding the tool at all. Losing
 *     either leaves a hole.
 *  2. The overlap between "destructive by slug" and "confirm-gated" is
 *     deliberate. Every tool on exactly one side is listed below WITH the
 *     reason, so a new tool that lands on one side only has to say why.
 *
 * "Behavioural test" here means: a test file in this directory that actually
 * invokes a handler (directly, or through the dispatcher) and takes the slug
 * as its SUBJECT. A generic property sweep like description-lint counts for
 * nothing here — it runs over every tool by construction and never exercises
 * a branch.
 *
 * "Subject" is three checks, because a plain substring match was satisfiable
 * by a comment. The 2026-09-03 audit demonstrated it: write the slug in a
 * `//` comment inside any handler-invoking file and the floor went green. So:
 *
 *  1. Comments are stripped before anything is matched. Prose about a tool is
 *     not coverage of it.
 *  2. The file must SELECT the def by that slug — `=== 'slug'`, `('slug')`,
 *     `('slug',`. Importing a bundle that happens to contain the tool is not
 *     enough; the file has to reach for this one.
 *  3. The slug must head a test block: `describe('slug'`, or a `name: 'slug'`
 *     row in a table driven by `describe.each` (builtins-crud-delete.test.ts
 *     is the exemplar — the block title comes from the data).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listBuiltins } from './registry';
import { CONTACT_AUTO_GRANT_SLUGS } from './builtins-contacts';
import { FORMULA_AUTO_GRANT_SLUGS } from './builtins-formulas';
import { JOURNAL_AUTO_GRANT_SLUGS } from './builtins-journal';

const TOOLS = listBuiltins();
const BY_SLUG = new Map(TOOLS.map((t) => [t.slug, t]));

/** Destructive by slug: the final verb removes something or revokes access.
 *  Slug-based on purpose — it is the one signal a NEW tool cannot forget to
 *  set. Widen it when a new verb arrives, never narrow it. */
const DESTRUCTIVE_VERB = /(^|_)(delete|rm|remove|unshare)$/;
const isDestructive = (slug: string): boolean => DESTRUCTIVE_VERB.test(slug);

const DESTRUCTIVE = TOOLS.filter((t) => isDestructive(t.slug)).map((t) => t.slug);
const CONFIRM_GATED = TOOLS.filter((t) => t.requiresConfirm === true).map((t) => t.slug);

/**
 * Destructive by slug but NOT confirm-gated. Each entry says why the gate is
 * not needed; `mcpOnly` entries are additionally checked against the def, so
 * the reason cannot outlive the flag. Grow this list deliberately — an entry
 * without a real reason is a gate someone forgot.
 */
const DESTRUCTIVE_WITHOUT_CONFIRM: Record<string, { reason: string; mcpOnly?: true }> = {
  // Operator-only surface: reachable over MCP by the owner working by hand;
  // no agent can be granted these (registry.listSeedableBuiltins excludes them).
  file_delete: { reason: 'owner-only operator surface', mcpOnly: true },
  folder_delete: { reason: 'owner-only operator surface', mcpOnly: true },
  note_delete: { reason: 'owner-only operator surface', mcpOnly: true },
  // Recoverable: undoes a share, a draft edit, or a pool entry.
  node_unshare: { reason: 'revokes a link; the gated half is node_share' },
  page_unshare: { reason: 'revokes a link; the gated half is page_share' },
  page_block_delete: { reason: 'writes to DRAFT; page_discard_draft reverts it' },
  model_pool_remove: { reason: 'pool entry; model_pool_set restores it' },
  app_table_export_remove: { reason: 'dissolves a mirror link; deletes no data' },
  // Routine editing inside an authoring kit whose whole-object delete IS gated
  // (table_delete, app_delete) and lives in a deliberate *-admin group.
  table_row_delete: { reason: 'grid editing; the gated whole is table_delete' },
  table_column_delete: { reason: 'grid editing; the gated whole is table_delete' },
  table_tab_delete: { reason: 'grid editing; the gated whole is table_delete' },
  app_file_delete: { reason: 'workspace file; the gated whole is app_delete' },
  // Single-row CRUD deletes granted only through a deliberately-held group
  // (events, tasks, formulas-admin, toolsmith) — never auto-granted.
  event_delete: { reason: 'row delete via the deliberate events group' },
  task_delete: { reason: 'row delete via the deliberate tasks group' },
  formula_delete: { reason: 'row delete via formulas-admin, deliberate-only' },
  api_tool_delete: { reason: 'row delete via the toolsmith kit, specialist-only' },
};

/**
 * Confirm-gated but NOT destructive by slug. These are the outward-facing
 * tools: nothing is deleted, but something leaves the brain and cannot be
 * recalled once it has.
 */
const CONFIRM_WITHOUT_DESTRUCTIVE_SLUG: Record<string, string> = {
  email_send: 'mail leaves the brain',
  email_page: 'mail leaves the brain',
  telegram_send: 'message leaves the brain',
  node_share: 'publishes brain content outward',
  page_share: 'publishes brain content outward',
};

/** Every tool the floor applies to: destructive OR confirm-gated. */
const GUARDED = Array.from(new Set([...DESTRUCTIVE, ...CONFIRM_GATED])).sort();

// ---- what counts as a behavioural test ------------------------------------

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = basename(fileURLToPath(import.meta.url));

/** A test file invokes a handler when it calls `.handler(` on a def, or goes
 *  through the dispatcher. Built from parts so this file's own source cannot
 *  match itself (it is also excluded by name — belt and braces). */
const INVOKES_HANDLER = new RegExp(['\\.handler', '\\(', '|dispatchTool|runTool\\('].join(''));

/**
 * Drop `//` and block comments, keeping string literals intact (a slug inside
 * a quoted string is real code; a slug inside prose is not). Small hand-rolled
 * scanner rather than a parser: the input is our own test sources, and the
 * only thing it has to get right is not treating a `/` inside a string as the
 * start of a comment.
 */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const BEHAVIOURAL_SOURCES: Array<{ file: string; src: string }> = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.test.ts') && f !== THIS_FILE)
  .map((file) => ({ file, src: stripComments(readFileSync(join(SRC_DIR, file), 'utf8')) }))
  .filter(({ src }) => INVOKES_HANDLER.test(src));

/** The file reaches for THIS def: `=== 'slug'`, `('slug')`, `('slug',`. */
const selectsDef = (slug: string): RegExp =>
  new RegExp(`(===\\s*'${slug}'|\\('${slug}'\\)|\\('${slug}',)`);

/** The slug HEADS a test block, literally or through a describe.each row. The
 *  describe title may carry a trailing gloss (`describe('table_delete (whole
 *  table, irreversible)'`), so match the slug at the start of the title and
 *  stop at a non-slug character rather than requiring the closing quote. */
const headsABlock = (slug: string): RegExp =>
  new RegExp(`(describe(\\.\\w+)?\\(\\s*'${slug}(?![a-z0-9_])|name:\\s*'${slug}')`);

function testFilesNaming(slug: string): string[] {
  return BEHAVIOURAL_SOURCES.filter(
    ({ src }) => selectsDef(slug).test(src) && headsABlock(slug).test(src),
  ).map(({ file }) => file);
}

// ---- the floor --------------------------------------------------------------

describe('destructive + confirm-gated tools: every one has a behavioural test', () => {
  it('found the handler-invoking test files at all', () => {
    // If this fails the sweep below would pass vacuously in the other
    // direction — it could not, but a moved directory or a renamed pattern
    // must fail loudly rather than quietly report "nothing untested".
    expect(BEHAVIOURAL_SOURCES.length).toBeGreaterThan(5);
    expect(testFilesNaming('page_commit')).toContain('builtins-pages-commit.test.ts');
  });

  it('applies to a non-trivial set (positive control)', () => {
    expect(DESTRUCTIVE.length).toBeGreaterThanOrEqual(20);
    expect(CONFIRM_GATED.length).toBeGreaterThanOrEqual(10);
  });

  for (const slug of GUARDED) {
    it(`${slug} is exercised by a handler-invoking test`, () => {
      const files = testFilesNaming(slug);
      expect(
        files,
        `${slug} is ${isDestructive(slug) ? 'destructive' : 'confirm-gated'} and no test file ` +
          `invokes its handler. Add a behavioural test (pattern: builtins-pages-commit.test.ts) ` +
          `that names the slug and calls def.handler(input, ctx) on both arms.`,
      ).not.toEqual([]);
    });
  }
});

// ---- invariant 1: destructive tools stay out of auto-grant ------------------

describe('no destructive or confirm-gated tool rides an auto-grant list', () => {
  const lists: Array<[string, readonly string[], string]> = [
    ['CONTACT_AUTO_GRANT_SLUGS', CONTACT_AUTO_GRANT_SLUGS, 'contact_'],
    ['JOURNAL_AUTO_GRANT_SLUGS', JOURNAL_AUTO_GRANT_SLUGS, 'journal_'],
    ['FORMULA_AUTO_GRANT_SLUGS', FORMULA_AUTO_GRANT_SLUGS, 'formula_'],
  ];

  for (const [name, list, prefix] of lists) {
    it(`${name} names only real, ungated, non-destructive tools`, () => {
      expect(list.length).toBeGreaterThan(0);
      for (const slug of list) {
        expect(BY_SLUG.has(slug), `${name} names unknown tool ${slug}`).toBe(true);
        expect(isDestructive(slug), `${name} auto-grants destructive ${slug}`).toBe(false);
        expect(BY_SLUG.get(slug)?.requiresConfirm, `${name} auto-grants gated ${slug}`).not.toBe(
          true,
        );
      }
    });

    it(`${name} has a destructive sibling it deliberately leaves out (positive control)`, () => {
      // Guards the assertion above against passing because the package has
      // no destructive tool at all — the exclusion only means something if
      // there is something to exclude.
      const siblings = DESTRUCTIVE.filter((s) => s.startsWith(prefix));
      expect(siblings).not.toEqual([]);
      for (const s of siblings) expect(list).not.toContain(s);
    });
  }
});

// ---- invariant 2: the destructive / confirm overlap is deliberate -----------

describe('destructive vs confirm-gated: every one-sided tool is accounted for', () => {
  it('every destructive tool without a confirm gate is listed with a reason', () => {
    const unlisted = DESTRUCTIVE.filter((s) => !CONFIRM_GATED.includes(s)).sort();
    expect(
      unlisted,
      'a destructive tool without requiresConfirm must be added to DESTRUCTIVE_WITHOUT_CONFIRM ' +
        'with the reason the gate is not needed — or gain the gate',
    ).toEqual(Object.keys(DESTRUCTIVE_WITHOUT_CONFIRM).sort());
  });

  it('every confirm-gated tool that is not destructive by slug is listed with a reason', () => {
    const unlisted = CONFIRM_GATED.filter((s) => !isDestructive(s)).sort();
    expect(unlisted).toEqual(Object.keys(CONFIRM_WITHOUT_DESTRUCTIVE_SLUG).sort());
  });

  it('the listed reasons still hold: mcpOnly claims match the defs', () => {
    for (const [slug, entry] of Object.entries(DESTRUCTIVE_WITHOUT_CONFIRM)) {
      const def = BY_SLUG.get(slug);
      expect(def, `${slug} no longer exists — drop it from the list`).toBeDefined();
      if (entry.mcpOnly) {
        // The reason "no agent can hold it" is only true while the flag is set.
        expect(def?.mcpOnly, `${slug} is listed as mcpOnly but the def is not`).toBe(true);
      } else {
        // And the reverse: an mcpOnly tool listed under an agent-facing reason
        // has the wrong reason, which is how a stale entry starts.
        expect(def?.mcpOnly, `${slug} is mcpOnly — say so in its entry`).not.toBe(true);
      }
    }
  });

  it('no gated tool is also marked read-only', () => {
    // read-only.test.ts pins this from the read-only side; pinned here from
    // the gate side so the two suites cannot drift apart silently.
    const offenders = TOOLS.filter((t) => t.requiresConfirm === true && t.readOnly === true);
    expect(offenders.map((t) => t.slug)).toEqual([]);
  });
});
