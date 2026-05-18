/**
 * Built-in tool handlers — wrappers around existing workspace functions so
 * the agent runtime can call them via the same dispatch path as user-defined
 * tools. Every entry maps 1:1 to a row that gets upserted into the `tools`
 * table on agent boot.
 *
 * Slug convention: snake_case, matching the MCP tool name where one exists,
 * so the same name surfaces to Claude Code and to in-app agents.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes, telegramChats } from '@mantle/db';
import {
  searchNodes,
  searchEntities,
  entityNeighbors,
  entityFacts,
  entityMentions,
} from '@mantle/search';
import {
  fileById,
  folderByPath,
  listAllFolders,
  listFiles,
  listFolders,
  readFileById,
  upsertFile,
} from '@mantle/files';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown, dflt?: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return dflt;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

// ─── search / tree ────────────────────────────────────────────────────────

const search_nodes: BuiltinToolDef = {
  slug: 'search_nodes',
  name: 'Search nodes',
  description:
    "Hybrid full-text + tree search across the user's Mantle. Use this when the user asks about a thing by content rather than by id. Optional `branch` (ltree prefix, e.g. 'files.work') scopes the search; `type` filters to one node kind; `tags` narrows further.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'free-text query' },
      branch: { type: 'string', description: "ltree prefix scope, e.g. 'files.work'" },
      type: {
        type: 'string',
        description: 'node type filter',
        enum: [
          'branch',
          'email',
          'email_thread',
          'file',
          'note',
          'sermon',
          'contact',
          'task',
          'event',
          'printer_project',
          'telegram_message',
        ],
      },
      tags: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  handler: async (input, ctx) => {
    try {
      const rows = await searchNodes({
        ownerId: ctx.ownerId,
        q: strOpt(input.q),
        branch: strOpt(input.branch),
        type: strOpt(input.type) as Parameters<typeof searchNodes>[0]['type'],
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
        limit: num(input.limit, 20),
      });
      ctx.step?.setOutput({ count: rows.length });
      return {
        ok: true,
        output: rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          path: r.path,
          tags: r.tags,
          summary:
            typeof (r.data as Record<string, unknown> | null)?.summary === 'string'
              ? (r.data as Record<string, unknown>).summary
              : null,
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const tree_list: BuiltinToolDef = {
  slug: 'tree_list',
  name: 'List tree children',
  description:
    "List children of a branch in the user's tree. Pass `path` to scope (ltree, e.g. 'files.work'). Omit for top-level branches.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'parent ltree path; omit for top-level' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    },
  },
  handler: async (input, ctx) => {
    const path = strOpt(input.path);
    const limit = num(input.limit, 100) ?? 100;
    const conds = [eq(nodes.ownerId, ctx.ownerId)];
    if (path) conds.push(sql`${nodes.path}::text = ${path}`);
    else conds.push(eq(nodes.type, 'branch'));
    const rows = await db
      .select({ id: nodes.id, title: nodes.title, type: nodes.type, path: nodes.path })
      .from(nodes)
      .where(and(...conds))
      .orderBy(desc(nodes.updatedAt))
      .limit(limit);
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

// ─── entities / facts ─────────────────────────────────────────────────────

const entity_search: BuiltinToolDef = {
  slug: 'entity_search',
  name: 'Search entities',
  description:
    "Resolve a name or alias to entities the user has accumulated (people, projects, places, orgs, events). Returns hits with similarity scores. Use this when the user mentions someone or something by name and you need their internal id.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'name or alias to resolve' },
      kind: {
        type: 'string',
        description: 'optional kind filter',
        enum: ['person', 'project', 'place', 'org', 'event'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['q'],
  },
  handler: async (input, ctx) => {
    const q = str(input.q);
    if (!q) return { ok: false, error: 'q required' };
    const rows = await searchEntities({
      ownerId: ctx.ownerId,
      q,
      kind: strOpt(input.kind),
      limit: num(input.limit, 10),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const entity_neighbors: BuiltinToolDef = {
  slug: 'entity_neighbors',
  name: 'Walk entity neighbors',
  description:
    "Given an entity id, return connected entities one hop away (in both directions by default). Use after entity_search to expand context, e.g. 'who works with Sarah?' or 'what projects mention Lister?'.",
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', format: 'uuid' },
      relation: { type: 'string' },
      direction: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' },
      current_only: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityNeighbors({
      ownerId: ctx.ownerId,
      entityId,
      relation: strOpt(input.relation),
      direction: (strOpt(input.direction) ?? 'both') as 'in' | 'out' | 'both',
      currentOnly: bool(input.current_only),
      limit: num(input.limit, 25),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const entity_facts: BuiltinToolDef = {
  slug: 'entity_facts',
  name: 'List entity facts',
  description:
    "All facts the user has accumulated about a specific entity. Returns currently-valid facts by default; set include_retired=true to see superseded history too.",
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', format: 'uuid' },
      include_retired: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityFacts({
      ownerId: ctx.ownerId,
      entityId,
      includeRetired: bool(input.include_retired),
      limit: num(input.limit, 50),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const entity_mentions: BuiltinToolDef = {
  slug: 'entity_mentions',
  name: 'List entity mentions',
  description:
    "Content nodes (files, notes, emails, ...) that mention a given entity, newest first. Returns title + per-node summary so the model can decide which to dig into.",
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', format: 'uuid' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityMentions({
      ownerId: ctx.ownerId,
      entityId,
      limit: num(input.limit, 25),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

// ─── files / folders ──────────────────────────────────────────────────────

const folder_list: BuiltinToolDef = {
  slug: 'folder_list',
  name: 'List folders',
  description:
    "List folders in the user's host-mirrored filesystem. Pass `parent` (ltree path, e.g. 'files.work') for that folder's children; pass `tree: true` for every folder under the root.",
  inputSchema: {
    type: 'object',
    properties: {
      parent: { type: 'string' },
      tree: { type: 'boolean', default: false },
    },
  },
  handler: async (input, ctx) => {
    if (bool(input.tree)) {
      const rows = await listAllFolders(ctx.ownerId);
      ctx.step?.setOutput({ count: rows.length });
      return { ok: true, output: rows };
    }
    const parent = strOpt(input.parent) ?? 'files';
    const rows = await listFolders({ ownerId: ctx.ownerId, parentPath: parent });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const file_list: BuiltinToolDef = {
  slug: 'file_list',
  name: 'List files in a folder',
  description:
    "List files in a specific folder. `parent_path` is the ltree path of the folder (e.g. 'files.work.lister-printer').",
  inputSchema: {
    type: 'object',
    properties: { parent_path: { type: 'string' } },
    required: ['parent_path'],
  },
  handler: async (input, ctx) => {
    const parentPath = str(input.parent_path);
    if (!parentPath) return { ok: false, error: 'parent_path required' };
    const rows = await listFiles({ ownerId: ctx.ownerId, parentPath });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const file_read: BuiltinToolDef = {
  slug: 'file_read',
  name: 'Read a file',
  description:
    "Read a file's content by id. For text files (.md / .txt / .json / .yaml) returns the body as a utf-8 string; for binaries returns a short metadata object only (no bytes).",
  inputSchema: {
    type: 'object',
    properties: { file_id: { type: 'string', format: 'uuid' } },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return { ok: false, error: 'file not found' };
    if (!meta.isText) {
      ctx.step?.setOutput({ binary: true });
      return { ok: true, output: { file: meta, content: null } };
    }
    const res = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!res) return { ok: false, error: 'file not found' };
    return { ok: true, output: { file: meta, content: res.bytes.toString('utf8') } };
  },
};

const file_get: BuiltinToolDef = {
  slug: 'file_get',
  name: 'Fetch file metadata',
  description: "Fetch a file's metadata (no bytes). Useful to confirm size/type before deciding to read.",
  inputSchema: {
    type: 'object',
    properties: { file_id: { type: 'string', format: 'uuid' } },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const row = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!row) return { ok: false, error: 'file not found' };
    return { ok: true, output: row };
  },
};

const folder_get_by_path: BuiltinToolDef = {
  slug: 'folder_get_by_path',
  name: 'Look up folder by path',
  description: "Look up a folder's metadata + description by its ltree path.",
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  handler: async (input, ctx) => {
    const path = str(input.path);
    if (!path) return { ok: false, error: 'path required' };
    const row = await folderByPath({ ownerId: ctx.ownerId, path });
    if (!row) return { ok: false, error: 'folder not found' };
    return { ok: true, output: row };
  },
};

const file_create: BuiltinToolDef = {
  slug: 'file_create',
  name: 'Create / overwrite a file',
  description:
    "Create or overwrite a text file in a folder. Use this when the user asks you to save a note, draft, or piece of content. Filename is lowercased and sanitised automatically.",
  requiresConfirm: false, // text-only writes are usually safe; user can flip per agent
  inputSchema: {
    type: 'object',
    properties: {
      parent_path: { type: 'string', description: "ltree path of the parent folder" },
      filename: { type: 'string', description: 'with extension, e.g. notes.md' },
      content: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
    },
    required: ['parent_path', 'filename', 'content'],
  },
  handler: async (input, ctx) => {
    const parentPath = str(input.parent_path);
    const filename = str(input.filename);
    const content = str(input.content);
    if (!parentPath || !filename) {
      return { ok: false, error: 'parent_path + filename required' };
    }
    try {
      const row = await upsertFile({
        ownerId: ctx.ownerId,
        parentPath,
        filename,
        bytes: Buffer.from(content, 'utf8'),
        overwrite: bool(input.overwrite),
      });
      ctx.step?.setOutput({ fileId: row.id });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ─── telegram ─────────────────────────────────────────────────────────────

import { accountForChat, sendMessage } from '@mantle/telegram';

const telegram_send: BuiltinToolDef = {
  slug: 'telegram_send',
  name: 'Send a Telegram message',
  description:
    "Send a Telegram DM to one of the user's allowlisted chats. Use only when explicitly asked to message someone — never on the user's initiative without confirmation.",
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: "Telegram's numeric chat id (as string)" },
      text: { type: 'string', minLength: 1 },
      reply_to: { type: 'string', description: "optional telegram_message_id to thread under" },
      markdown: { type: 'boolean', default: false },
    },
    required: ['chat_id', 'text'],
  },
  handler: async (input, ctx) => {
    const chatId = str(input.chat_id);
    const text = str(input.text);
    if (!chatId || !text) return { ok: false, error: 'chat_id + text required' };
    const account = await accountForChat(chatId);
    if (!account) return { ok: false, error: 'no enabled telegram account for this chat' };
    // Verify allowlist on this owner.
    const [chat] = await db
      .select({ status: telegramChats.allowlistStatus })
      .from(telegramChats)
      .where(
        and(eq(telegramChats.userId, ctx.ownerId), eq(telegramChats.telegramChatId, chatId)),
      )
      .limit(1);
    if (!chat || chat.status !== 'allowed') {
      return { ok: false, error: `chat ${chatId} is not allowlisted` };
    }
    try {
      const ids = await sendMessage(account, chatId, text, {
        replyTo: strOpt(input.reply_to),
        markdown: bool(input.markdown),
      });
      ctx.step?.setOutput({ messageIds: ids });
      return { ok: true, output: { messageIds: ids } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ─── export the catalog ───────────────────────────────────────────────────

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  search_nodes,
  tree_list,
  entity_search,
  entity_neighbors,
  entity_facts,
  entity_mentions,
  folder_list,
  folder_get_by_path,
  file_list,
  file_get,
  file_read,
  file_create,
  telegram_send,
];
