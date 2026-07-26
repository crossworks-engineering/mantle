/**
 * Integration groups — the db/files-backed half of the binding layer that turns
 * a `tool_groups` row into an API *integration*: a base URL, a vault ref, where
 * the credential goes, and a pointer to the API's stored documentation.
 *
 * Used by the Toolsmith builtins AND the owner-facing API routes (server/web),
 * which is why it sits in @mantle/tools beside the other group helpers rather
 * than inside the builtins file. The pure rules — validation and the
 * authoring-time template inheritance — live in `integration-meta.ts` and are
 * re-exported here so callers only need one import.
 *
 * Docs are stored as a normal markdown FILE under `files/api-docs/<group>.md`,
 * through the same pipeline an upload uses, so they summarise + embed + FTS-index
 * like any other file and EVERY agent's `search_nodes` can find them.
 */

import { and, eq } from 'drizzle-orm';
import { db, toolGroups, type ToolGroupIntegration } from '@mantle/db';
import {
  dashToLtree,
  createFolder,
  ensureFilesRootBranch,
  folderByPath,
  readFileById,
  upsertFile,
} from '@mantle/files';
import { API_DOCS_MAX_CHARS, apiDocsHeader } from './integration-meta';

export {
  API_DOCS_MAX_CHARS,
  apiDocsHeader,
  applyIntegrationInheritance,
  describeInheritance,
  joinBaseUrl,
  parseIntegrationMeta,
  type InheritanceInput,
  type InheritanceResult,
  type InheritedPieces,
  type ParsedIntegration,
  type ToolGroupIntegration,
} from './integration-meta';

/* ─────────────────────── accessors (owner-scoped) ─────────────────────── */

export type IntegrationGroup = {
  id: string;
  slug: string;
  name: string;
  toolSlugs: string[];
  integration: ToolGroupIntegration | null;
};

/** The group row + its integration, or null when the group doesn't exist. */
export async function getGroupIntegration(
  ownerId: string,
  slug: string,
): Promise<IntegrationGroup | null> {
  const [row] = await db
    .select({
      id: toolGroups.id,
      slug: toolGroups.slug,
      name: toolGroups.name,
      toolSlugs: toolGroups.toolSlugs,
      integration: toolGroups.integration,
    })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, slug)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    toolSlugs: row.toolSlugs ?? [],
    integration: row.integration ?? null,
  };
}

/**
 * Merge `patch` into the group's integration and store it. Merging (not
 * replacing) is what lets `api_docs_set` attach a docs pointer without knowing
 * the auth template, and `tool_group_ensure` re-declare auth without dropping
 * the docs. Pass an explicit `null` for a field to clear it.
 */
export async function setGroupIntegration(
  ownerId: string,
  slug: string,
  patch: Partial<ToolGroupIntegration>,
): Promise<ToolGroupIntegration | null> {
  const existing = await getGroupIntegration(ownerId, slug);
  if (!existing) return null;
  const merged: Record<string, unknown> = { ...(existing.integration ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else if (v !== undefined) merged[k] = v;
  }
  const next = merged as unknown as ToolGroupIntegration;
  await db
    .update(toolGroups)
    .set({ integration: next, updatedAt: new Date() })
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, slug)));
  return next;
}

/* ───────────────────────── stored API documentation ───────────────────── */

/** Folder every integration's docs file lives in (disk name; the ltree label is
 *  `api_docs`). Files auto-index, so `search_nodes` finds these docs. */
export const API_DOCS_FOLDER_SLUG = 'api-docs';
export const API_DOCS_FOLDER_PATH = `files.${dashToLtree(API_DOCS_FOLDER_SLUG)}`;
const API_DOCS_FOLDER_DESCRIPTION =
  'Stored API documentation for integration tool groups. One markdown file per group, written by Toolsmith (api_docs_set) and read back with api_docs_get.';

/** Lazy-create `files/api-docs`, tolerating the concurrent-create race the same
 *  way `ensureDatedUploadFolder` does. */
async function ensureApiDocsFolder(ownerId: string): Promise<void> {
  await ensureFilesRootBranch(ownerId);
  const existing = await folderByPath({ ownerId, path: API_DOCS_FOLDER_PATH });
  if (existing) return;
  try {
    await createFolder({
      ownerId,
      parentPath: 'files',
      slug: API_DOCS_FOLDER_SLUG,
      description: API_DOCS_FOLDER_DESCRIPTION,
    });
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
  }
}

/**
 * Write (or replace) an integration's docs as `files/api-docs/<group-slug>.md`
 * through the normal file pipeline, so it indexes + embeds like any other file.
 * Returns the node id to stash in `integration.docsNodeId`.
 */
export async function upsertApiDocsFile(args: {
  ownerId: string;
  groupSlug: string;
  markdown: string;
  service?: string;
  sourceUrl?: string;
}): Promise<{ nodeId: string; filename: string; chars: number; capturedAt: string }> {
  await ensureApiDocsFolder(args.ownerId);
  const capturedAt = new Date().toISOString();
  const text =
    apiDocsHeader({
      groupSlug: args.groupSlug,
      service: args.service,
      sourceUrl: args.sourceUrl,
      capturedAt,
    }) + args.markdown.slice(0, API_DOCS_MAX_CHARS);
  const row = await upsertFile({
    ownerId: args.ownerId,
    parentPath: API_DOCS_FOLDER_PATH,
    filename: `${args.groupSlug}.md`,
    bytes: Buffer.from(text, 'utf8'),
    overwrite: true,
  });
  return { nodeId: row.id, filename: row.filename, chars: text.length, capturedAt };
}

/** Read a stored docs file back as text. Null when the node is gone (the owner
 *  deleted the file) — callers treat that as "no stored docs". */
export async function readApiDocsFile(args: {
  ownerId: string;
  nodeId: string;
}): Promise<{ text: string; filename: string } | null> {
  const hit = await readFileById({ ownerId: args.ownerId, fileId: args.nodeId });
  if (!hit) return null;
  return { text: hit.bytes.toString('utf8'), filename: hit.row.filename };
}
