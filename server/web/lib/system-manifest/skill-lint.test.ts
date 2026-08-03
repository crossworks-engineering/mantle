/**
 * Skill-prose lint: the cross-reference check from
 * packages/tools/src/description-lint.test.ts, ported to the manifest
 * skills. Tool DESCRIPTIONS were already guarded (a backticked slug that
 * names no registered tool fails the build); skill INSTRUCTIONS were not,
 * and they carry 170+ tool references that until now only a handful of
 * hand-pinned content assertions protected. Rename or retire a tool and a
 * skill would keep teaching it silently; this makes that a build failure.
 *
 * Resolution set: KNOWN_TOOL_SLUGS (builtins + external + manifest http
 * tools), i.e. everything a skill may legitimately teach. Judgment calls
 * (is the teaching still CORRECT?) stay with the content assertions in
 * manifest.test.ts; this file only guarantees the referenced surface exists.
 */

import { describe, expect, it } from 'vitest';
import { MANIFEST_SKILLS, KNOWN_TOOL_SLUGS } from './manifest';

/** Lowercase with at least one underscore: the shape of our tool slugs.
 *  Same regex as description-lint's SLUG_SHAPE; keep them in sync. */
const SLUG_SHAPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/**
 * Backticked underscore-tokens that look like tool slugs but aren't.
 * Grow deliberately (named param/field/config terms), with a reason per
 * entry; never loosen the regex instead, that's how rename rot gets back in.
 */
const NOT_A_TOOL_SLUG = new Set<string>([
  // Tool param / result fields the skills teach by name
  'node_id', // common node-id param (tool_grounding)
  'block_id', // page block tools' target param (page_editing)
  'created_ids', // page_blocks_apply result field, batch chaining (page_editing)
  'deleted_ids', // page_blocks_apply result field, batch chaining (page_editing)
  'draft_doc', // pages draft-state field on page rows (page_editing)
  'has_draft', // page_get result flag (page_editing)
  'mentioned_in', // page_mention edge kind (page_editing)
  'parent_id', // page_create / page_move param (page_editing)
  'subject_node_ids', // heartbeat_create param (specialist_routing)
  'coverage_gaps', // formula_get result field (formula_use / formula_authoring)
  'dimension_issues', // formula_get result field (formula_use / formula_authoring)
  'linked_to', // table column-type term (table_authoring)
  'total_matches', // table_query result-meta field (table_authoring)
  'purge_files', // sandbox_rm param (sandbox-work)
  'timeout_seconds', // sandbox_exec param (sandbox-work)
  // Deliberate non-tools named in prose
  'openweather_geocode', // app_authoring's "never invent a slug like this" example
  'table_xinfo', // SQLite PRAGMA table_xinfo, allowed read-only in app SQL
  'mantle_pg', // the Postgres container name (mantle-ops)
]);

/** Backticked tokens, with call-shaped suffixes stripped so
 *  `page_get({ id })` resolves as `page_get`. */
function slugTokens(text: string): string[] {
  return Array.from(text.matchAll(/`([^`\n]+)`/g), (m) => (m[1] ?? '').replace(/\(.*$/, '').trim())
    .filter((t) => SLUG_SHAPE.test(t));
}

describe('skill-prose lint', () => {
  it('every slug-shaped tool reference in skill instructions resolves to a known tool', () => {
    const stale: string[] = [];
    for (const skill of MANIFEST_SKILLS) {
      for (const token of slugTokens(skill.instructions)) {
        if (KNOWN_TOOL_SLUGS.has(token)) continue;
        if (NOT_A_TOOL_SLUG.has(token)) continue;
        stale.push(`${skill.slug}: \`${token}\``);
      }
    }
    expect(
      [...new Set(stale)],
      `unresolved slug-shaped references in skill prose (stale tool name, or add to NOT_A_TOOL_SLUG with a reason):\n  ${[...new Set(stale)].join('\n  ')}`,
    ).toEqual([]);
  });

  it('cross-reference allowlist carries no dead weight', () => {
    const referenced = new Set(MANIFEST_SKILLS.flatMap((s) => slugTokens(s.instructions)));
    const stale = [...NOT_A_TOOL_SLUG].filter((t) => !referenced.has(t));
    expect(
      stale,
      `no longer referenced by any skill; remove from NOT_A_TOOL_SLUG: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('the allowlist shadows no real tool (an entry that becomes a tool must be dropped)', () => {
    // If a slug on the allowlist later ships as a real tool, the allowlist
    // would silently swallow genuine references to it; force the cleanup.
    const shadowing = [...NOT_A_TOOL_SLUG].filter((t) => KNOWN_TOOL_SLUGS.has(t));
    expect(
      shadowing,
      `these allowlist entries now name REAL tools; remove them: ${shadowing.join(', ')}`,
    ).toEqual([]);
  });
});
