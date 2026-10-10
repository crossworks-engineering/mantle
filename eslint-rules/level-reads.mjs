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
 * The allowlist below is what is LEFT, file by file, with the number of
 * matching lines pinned (eslint-rules/level-reads.test.ts fails on any other
 * count, so a new read in a listed file fails too) and the phase that removes
 * it. W5b2 (bridge off, the Grant Access panel, links on the served list)
 * empties its section; W5c, W6b, W7 and W8 theirs. A file listed under 'keep'
 * uses the word for something else (an OAuth audience).
 *
 * Adding a file or raising a count is a review decision: say why in the PR.
 */
export const LEVEL_READ_PATTERN =
  /\baudience\b|share_level|shareLevel|inherited_level|inheritedLevel|embedded_level|embeddedLevel|currentViewerLevel|\breadAtSql\b|\breadAtAliasSql\b|\bisReadAt\b|\bitemLevel\b|\beffectiveLevelSql\b|\beffectiveLevel\b|mantle_team_reads|mantle_inherited_level|\blevelOfScope\b/;

/** @type {Record<string, { lines: number, phase: 'W5b2' | 'W5c' | 'W6b' | 'W7' | 'W8' | 'keep', why: string }>} */
export const LEVEL_READ_ALLOWLIST = {
  // ── W5b2 (the bridge writers, the old Access panel, public links, connector levels) ──
  'packages/tools/src/tool-results.ts': {
    lines: 3,
    phase: 'W5b2',
    why: 'levelOfScope: spill viewer level (level scopes go with the shim)',
  },
  'packages/runtime/src/agent/invoke-agent.ts': {
    lines: 2,
    phase: 'W5b2',
    why: 'levelOfScope: caller vs target agent level (level scopes go with the shim)',
  },
  'packages/content/src/access-shadow.ts': {
    lines: 9,
    phase: 'W5b2',
    why: 'display: access shadow report by level',
  },
  'packages/content/src/access.ts': {
    lines: 61,
    phase: 'W5b2',
    why: 'writer: the old level engine (setItemLevel, closure, links, agent and connector levels)',
  },
  'packages/content/src/apps.ts': {
    lines: 16,
    phase: 'W5b2',
    why: 'display + app tool level (client rules run for a client-level app)',
  },
  'packages/content/src/draws.ts': {
    lines: 6,
    phase: 'W5b2',
    why: 'display rows (list chips: the tree helper)',
  },
  'packages/content/src/embed-closure.ts': {
    lines: 1,
    phase: 'W5b2',
    why: 'deprecated no-op EmbedItem type: goes with the calls in access, shares, member-review, access-shadow',
  },
  'packages/content/src/item-level.ts': {
    lines: 24,
    phase: 'W5b2',
    why: 'the level helpers; the Team rule already reads grants (isTeamRule)',
  },
  'packages/content/src/mcp-app-data.ts': {
    lines: 10,
    phase: 'W5b2',
    why: 'member reach reads grants; the level shown and the public write rule stay',
  },
  'packages/content/src/member-apps.ts': {
    lines: 15,
    phase: 'W5b2',
    why: 'member app gate reads grants; listing and write rule tell public from team',
  },
  'packages/content/src/notes.ts': {
    lines: 6,
    phase: 'W5b2',
    why: 'display rows (list chips: the tree helper)',
  },
  'packages/content/src/pages/level-text.ts': {
    lines: 6,
    phase: 'W5b2',
    why: 'levelFilteredDoc/Note: the links helper',
  },
  'packages/content/src/shared-via.ts': {
    lines: 9,
    phase: 'W5b2',
    why: 'display: Shared via / Read through labels',
  },
  'packages/content/src/shares.ts': {
    lines: 14,
    phase: 'W5b2',
    why: 'public: links follow the level (served list, 8.1)',
  },
  'packages/content/src/tree/share-drift.ts': {
    lines: 16,
    phase: 'W5b2',
    why: 'writer: nightly inherited/embedded repair the bridge depends on',
  },
  'packages/content/src/tree/write.ts': { lines: 4, phase: 'W5b2', why: 'writer: setFolderShare' },
  'packages/db/src/grant-reads.ts': {
    lines: 2,
    phase: 'W5b2',
    why: 'the level fallback of mantle_item_team_reads (unmigrated brains, personal rows)',
  },
  'packages/mcp-core/src/shared-item.ts': {
    lines: 8,
    phase: 'W5b2',
    why: 'othersCanRead: folder share and app embeds are not in grants',
  },
  'packages/runtime/src/agent/skills.ts': {
    lines: 4,
    phase: 'W5b2',
    why: 'levelOfScope for the caller level (2 lines, the shim); then agent and tool-group levels (2 lines, kept until W7, contract 21): a connector group is capped by the agent level only, the scope decides the caller',
  },
  'packages/tools/src/app-tool-level.ts': {
    lines: 4,
    phase: 'W5b2',
    why: 'app tool level (client rules)',
  },
  'packages/tools/src/builtins-access.ts': {
    lines: 5,
    phase: 'W5b2',
    why: 'access_get returns levels',
  },
  'packages/tools/src/builtins-nodes.ts': {
    lines: 1,
    phase: 'W5b2',
    why: 'reply text names the level',
  },
  'packages/tools/src/builtins-share.ts': { lines: 1, phase: 'W5b2', why: 'public: unshare reply' },
  'packages/tools/src/dispatch.ts': {
    lines: 2,
    phase: 'W5b2',
    why: 'levelOfScope: the run level of a non-owner call (the shim); connectors read workspace_resources',
  },
  'server/web/app/api/access/agents/[slug]/route.ts': {
    lines: 5,
    phase: 'W5b2',
    why: 'writer: agent level route',
  },
  'server/web/app/api/access/nodes/[id]/route.ts': {
    lines: 7,
    phase: 'W5b2',
    why: 'writer: old Access route',
  },
  'server/web/app/api/access/tool-groups/[slug]/route.ts': {
    lines: 3,
    phase: 'W5b2',
    why: 'writer: connector level route',
  },
  'server/web/app/api/member/apps/[id]/tool-broker/route.ts': {
    lines: 1,
    phase: 'W5b2',
    why: 'app tool level',
  },
  'server/web/app/api/shares/[id]/route.ts': { lines: 1, phase: 'W5b2', why: 'public: comment' },
  'server/web/app/s/[token]/draw/route.ts': { lines: 3, phase: 'W5b2', why: 'public: link levels' },
  'server/web/components/share/folder-presenter.tsx': {
    lines: 3,
    phase: 'W5b2',
    why: 'public: link levels',
  },
  'server/web/lib/shares.ts': {
    lines: 21,
    phase: 'W5b2',
    why: 'public: link and contact share serving rules',
  },
  // ── W5c (member and client review, the client portal) ──
  'packages/client-types/src/dto/member-apps.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'DTO: member launcher card level',
  },
  'packages/client-types/src/dto/member.ts': {
    lines: 4,
    phase: 'W5c',
    why: 'DTO: member Library and review rows level',
  },
  'packages/client-types/src/dto/review.ts': {
    lines: 1,
    phase: 'W5c',
    why: 'DTO: accept request level (review goes)',
  },
  'packages/content/src/accept-place.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'display: share the accepted item would inherit',
  },
  'packages/content/src/app-table-exports.ts': {
    lines: 3,
    phase: 'W5c',
    why: 'client: client app state',
  },
  'packages/content/src/chat-images.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'client: client chat image reach',
  },
  'packages/content/src/client-admin-usage.ts': {
    lines: 1,
    phase: 'W5c',
    why: 'client: client app usage',
  },
  'packages/content/src/client-apps.ts': {
    lines: 9,
    phase: 'W5c',
    why: 'client: client app list and gate',
  },
  'packages/content/src/client-draw-images.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'client: client drawing images',
  },
  'packages/content/src/client-old-links.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'client: retired client links',
  },
  'packages/content/src/client-report.ts': { lines: 9, phase: 'W5c', why: 'client: client report' },
  'packages/content/src/client-shared.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'client: client shared reads',
  },
  'packages/content/src/member-draw-images.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'member drawing images (Library levels)',
  },
  'packages/content/src/member-items.ts': {
    lines: 5,
    phase: 'W5c',
    why: 'member Library and accepted rows',
  },
  'packages/content/src/member-library.ts': {
    lines: 6,
    phase: 'W5c',
    why: 'member Library (team levels without public)',
  },
  'packages/content/src/member-review.ts': {
    lines: 28,
    phase: 'W5c',
    why: 'review: accept sets levels',
  },
  'packages/content/src/member-space-apps.ts': {
    lines: 3,
    phase: 'W5c',
    why: 'review: member app accept sets level',
  },
  'packages/content/src/tree/member-tree.ts': {
    lines: 1,
    phase: 'W5c',
    why: 'member tree (Library levels)',
  },
  'packages/content/src/tree/reader.ts': {
    lines: 3,
    phase: 'W5c',
    why: 'member/client tree reader (Library levels)',
  },
  'packages/runtime/src/assistant/run-team-turn.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'agent level per login role',
  },
  'packages/tools/src/client-app-tools.ts': { lines: 1, phase: 'W5c', why: 'client app tools' },
  'packages/tools/src/client-sourced-rules.ts': {
    lines: 13,
    phase: 'W5c',
    why: 'client-sourced write holds',
  },
  'packages/tools/src/client-sourced.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'client-sourced export tables',
  },
  'scripts/client-level-counts.sql': { lines: 7, phase: 'W5c', why: 'one-off client counts' },
  'server/web/app/api/admin/space/[id]/accept/route.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'review accept level',
  },
  'server/web/app/api/client/apps/[id]/db-broker/route.ts': {
    lines: 1,
    phase: 'W5c',
    why: 'client comment',
  },
  'server/web/app/api/client/chat/route.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'client chat agent level',
  },
  'server/web/app/api/member/apps/[id]/db-broker/route.ts': {
    lines: 1,
    phase: 'W5c',
    why: 'member comment',
  },
  'server/web/app/api/member/chat/route.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'member chat agent level',
  },
  'server/web/app/api/team-admin/hub-app/route.ts': {
    lines: 1,
    phase: 'W5c',
    why: 'writer: hub app raised to team',
  },
  'server/web/app/api/team-admin/submissions/[id]/accept/route.ts': {
    lines: 2,
    phase: 'W5c',
    why: 'review accept level',
  },
  'server/web/lib/member-apps.ts': { lines: 1, phase: 'W5c', why: 'member app card level' },
  // ── W6b (personal-space rows, accepted-item author path) ──
  'packages/content/src/member-accepted.ts': {
    lines: 8,
    phase: 'W6b',
    why: 'accepted items: author read path must stay until the S3 snapshot task (HANDOVER 4)',
  },
  'packages/content/src/tree/member-tree-write.ts': {
    lines: 1,
    phase: 'W6b',
    why: 'personal folder insert names the level default',
  },
  // ── W7 (MCP, peers, Telegram) ──
  'packages/tools/src/agent-grants.ts': {
    lines: 5,
    phase: 'W7',
    why: 'agent and tool-group levels (kept until W7, contract 21): an agent holds groups at or below its level',
  },
  'packages/tools/src/member-app-tools.ts': {
    lines: 1,
    phase: 'W7',
    why: 'agent and tool-group levels (kept until W7, contract 21): a member app draws built-ins from team-level groups',
  },
  'packages/tools/src/toolsmith/groups.ts': {
    lines: 6,
    phase: 'W7',
    why: 'agent and tool-group levels (kept until W7, contract 21): grant and group-change rules (4 lines); OAuth audience (2 lines, keep)',
  },
  'packages/mcp-core/src/login-surface.ts': {
    lines: 3,
    phase: 'W7',
    why: 'agent level of the MCP login responder',
  },
  'packages/telegram/src/chat-level.ts': { lines: 2, phase: 'W7', why: 'agent level of a chat' },
  'packages/telegram/src/level.ts': { lines: 6, phase: 'W7', why: 'agent level checks' },
  'server/api/src/agent/runtime.ts': { lines: 3, phase: 'W7', why: 'Telegram agent level' },
  'server/web/app/api/telegram/chats/[id]/route.ts': {
    lines: 1,
    phase: 'W7',
    why: 'Telegram agent level',
  },
  'server/web/lib/agent-telegram.ts': { lines: 1, phase: 'W7', why: 'Telegram agent level' },
  // ── W8 (schema columns, DTO fields, comments, the deprecated function) ──
  'packages/db/src/client.ts': {
    lines: 3,
    phase: 'W8',
    why: 'levelOfScope picks the level pool (db internals)',
  },
  'packages/client-types/src/dto/access.ts': {
    lines: 3,
    phase: 'W8',
    why: 'DTO: old Access panel level fields',
  },
  'packages/client-types/src/dto/agent-graph.ts': {
    lines: 2,
    phase: 'W8',
    why: 'DTO: connector level field',
  },
  'packages/client-types/src/dto/rows.ts': {
    lines: 3,
    phase: 'W8',
    why: 'DTO: owner row level badge',
  },
  'packages/client-types/src/tree.ts': { lines: 3, phase: 'W8', why: 'DTO: tree share levels' },
  'packages/content-core/src/table-model.ts': {
    lines: 2,
    phase: 'W8',
    why: 'DTO: table row level badge',
  },
  'packages/content-core/src/tree.ts': {
    lines: 1,
    phase: 'W8',
    why: 'effectiveLevel, the level combiner',
  },
  'packages/content/src/formulas.ts': { lines: 5, phase: 'W8', why: 'display: formula row level' },
  'packages/content/src/pages/shared.ts': { lines: 1, phase: 'W8', why: 'display: page row level' },
  'packages/content/src/tables/shared.ts': {
    lines: 3,
    phase: 'W8',
    why: 'display: table row level',
  },
  'packages/content/src/tree/marks.ts': {
    lines: 1,
    phase: 'W8',
    why: 'display: pinned rows level',
  },
  'packages/db/src/access-matrix.ts': { lines: 3, phase: 'W8', why: 'comments' },
  'packages/db/src/index.ts': {
    lines: 2,
    phase: 'W8',
    why: 'export of the deprecated currentViewerLevel',
  },
  'packages/db/src/schema/agents.ts': { lines: 1, phase: 'W8', why: 'schema: agents.audience' },
  'packages/db/src/schema/node-embeds.ts': { lines: 1, phase: 'W8', why: 'schema comment' },
  'packages/db/src/schema/nodes.ts': { lines: 4, phase: 'W8', why: 'schema: the level columns' },
  'packages/db/src/schema/tool-groups.ts': {
    lines: 2,
    phase: 'W8',
    why: 'schema: tool_groups.audience (+ an OAuth audience field)',
  },
  'packages/db/src/viewer.ts': {
    lines: 7,
    phase: 'W8',
    why: 'the deprecated currentViewerLevel itself',
  },
  'packages/files/src/ops/shared.ts': {
    lines: 13,
    phase: 'W8',
    why: 'display: Files row level badges',
  },
  'packages/runtime/src/agent/agent-viewer.ts': {
    lines: 4,
    phase: 'W8',
    why: 'agent level (agentLevel)',
  },
  'packages/runtime/src/agent/tool-loop.ts': {
    lines: 2,
    phase: 'W8',
    why: 'agent level passed to the scope',
  },
  'server/web/app/api/agents/[id]/route.ts': {
    lines: 2,
    phase: 'W8',
    why: 'agent vs group level on grant',
  },
  'server/web/lib/maintenance/registry.ts': { lines: 1, phase: 'W8', why: 'task description text' },
  'server/web/lib/mcp-connectors.ts': { lines: 1, phase: 'W8', why: 'connector DTO level' },
  'server/web/lib/system-manifest/manifest.ts': { lines: 2, phase: 'W8', why: 'comments' },
  'server/web/lib/system-manifest/reconcile.ts': {
    lines: 6,
    phase: 'W8',
    why: 'agent vs group level',
  },
  'server/web/lib/system-manifest/seed.ts': {
    lines: 4,
    phase: 'W8',
    why: 'seeded agent and group levels',
  },
  'server/web/lib/tool-groups.ts': { lines: 1, phase: 'W8', why: 'connector DTO level' },
  // ── keep (the word means something else: OAuth audience, plain English) ──
  'packages/tools/src/integration-meta.ts': {
    lines: 7,
    phase: 'keep',
    why: 'unrelated: the OAuth2 audience parameter',
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
