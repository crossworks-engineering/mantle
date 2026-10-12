/**
 * The level-reads sweep (workspaces plan S2, from phase W5b1 on). Access is
 * decided by workspace grants, not by the tier levels: no product code may
 * read the level columns (nodes.audience, share_level, inherited_level,
 * embedded_level, agents.audience, tool_groups.audience), the helpers that
 * read them for you (readAtSql, readAtAliasSql, isReadAt, itemLevel,
 * effectiveLevel, effectiveLevelSql, mantle_team_reads,
 * mantle_inherited_level), or currentViewerLevel and levelOfScope (the tier
 * level of a scope: use currentScope() and handle every kind, or
 * scopeHasArea()).
 *
 * Swept: packages/, server/, scripts/ (.ts, .tsx, .mjs, .js, .sql). Not swept:
 * tests, packages/db/migrations/ and any archive/ folder.
 *
 * A permanent guard since W8c, which took the last level read out of the
 * code (the columns stay in the database, frozen, until W10 drops them).
 * The allowlist below holds only files where the word means something else
 * (an OAuth audience, plain English), with the number of matching lines
 * pinned: eslint-rules/level-reads.test.ts fails on any other count, so a
 * new read in a listed file fails too, and on any `audience` line outside
 * the list.
 *
 * Adding a file or raising a count is a review decision: say why in the PR.
 */
export const LEVEL_READ_PATTERN =
  /\baudience\b|share_level|shareLevel|inherited_level|inheritedLevel|embedded_level|embeddedLevel|currentViewerLevel|\breadAtSql\b|\breadAtAliasSql\b|\bisReadAt\b|\bitemLevel\b|\beffectiveLevelSql\b|\beffectiveLevel\b|mantle_team_reads|mantle_inherited_level|\blevelOfScope\b/;

/** @type {Record<string, { lines: number, phase: 'keep', why: string }>} */
export const LEVEL_READ_ALLOWLIST = {
  // ── keep (the word means something else: OAuth audience, plain English) ──
  'packages/db/src/schema/tool-groups.ts': {
    lines: 1,
    phase: 'keep',
    why: 'unrelated: the OAuth2 audience field of an integration group',
  },
  'packages/tools/src/integration-meta.ts': {
    lines: 7,
    phase: 'keep',
    why: 'unrelated: the OAuth2 audience parameter',
  },
  'packages/tools/src/toolsmith/groups.ts': {
    lines: 3,
    phase: 'keep',
    why: 'unrelated: the OAuth2 audience parameter of an integration group',
  },
  'packages/tools/src/mcp-oauth.ts': {
    lines: 1,
    phase: 'keep',
    why: 'unrelated: OAuth token audience comment',
  },
  'packages/tools/src/oauth2-client-credentials.ts': {
    lines: 2,
    phase: 'keep',
    why: 'unrelated: the OAuth2 audience parameter',
  },
  'server/api/src/turn-stream-observer.ts': {
    lines: 1,
    phase: 'keep',
    why: 'unrelated: plain English comment',
  },
  'server/web/lib/draw-snapshot.ts': {
    lines: 1,
    phase: 'keep',
    why: 'unrelated: plain English comment',
  },
};

/** The repo-relative path of `filename` (absolute or relative), from the
 *  first packages/, server/ or scripts/ segment; null outside them. */
export function repoPath(filename) {
  const f = filename.replace(/\\/g, '/');
  const m = /(?:^|\/)((?:packages|server|scripts)\/.*)$/.exec(f);
  return m ? m[1] : null;
}

/** Whether the sweep reads `path` (repo-relative) at all. */
export function isSwept(path) {
  if (!path || !/\.(ts|tsx|mjs|js|sql)$/.test(path)) return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  if (path.startsWith('packages/db/migrations/')) return false;
  if (/(^|\/)archive\//.test(path) || path.includes('/node_modules/')) return false;
  return true;
}

/** The number of lines of `text` the sweep matches. */
export function countLevelReads(text) {
  return text.split('\n').filter((l) => LEVEL_READ_PATTERN.test(l)).length;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'No product code reads the tier levels (workspaces plan S2).' },
    messages: {
      levelRead:
        'Access comes from workspace grants: read nodes.read_ws / item_grants (teamReadsSql from @mantle/db) or currentScope() / scopeHasArea(), not the level columns, their helpers or currentViewerLevel. See eslint-rules/level-reads.mjs.',
    },
    schema: [],
  },
  create(context) {
    const path = repoPath(context.filename);
    if (!isSwept(path) || Object.hasOwn(LEVEL_READ_ALLOWLIST, path)) return {};
    return {
      Program(node) {
        const lines = context.sourceCode.getText().split('\n');
        lines.forEach((text, i) => {
          if (!LEVEL_READ_PATTERN.test(text)) return;
          context.report({
            node,
            loc: { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: text.length } },
            messageId: 'levelRead',
          });
        });
      },
    };
  },
};

export default { rules: { 'level-reads': rule } };
