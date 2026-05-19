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
import { db, nodes, secrets, telegramChats } from '@mantle/db';
import { seal } from '@mantle/crypto';
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

const node_read: BuiltinToolDef = {
  slug: 'node_read',
  name: 'Read a node',
  description:
    "Read the full content of any node by id — note, event, task, secret, sermon, contact, etc. Returns title, type, tags, path, summary, and the full `data` blob (which includes the markdown body for notes, body+location+starts_at for events, status+due_at for tasks, and so on). Use this when search_nodes gives you an id and you need the actual body, not just the summary. For nodes of type='file' the file body lives in object storage — use `file_read` instead.",
  inputSchema: {
    type: 'object',
    properties: { node_id: { type: 'string', format: 'uuid' } },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    const nodeId = str(input.node_id);
    if (!nodeId) return { ok: false, error: 'node_id required' };
    const [row] = await db
      .select({
        id: nodes.id,
        type: nodes.type,
        title: nodes.title,
        path: nodes.path,
        tags: nodes.tags,
        data: nodes.data,
        createdAt: nodes.createdAt,
        updatedAt: nodes.updatedAt,
      })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
      .limit(1);
    if (!row) return { ok: false, error: 'node not found' };
    ctx.step?.setOutput({ type: row.type });
    return {
      ok: true,
      output: {
        id: row.id,
        type: row.type,
        title: row.title,
        path: row.path,
        tags: row.tags,
        data: row.data,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  },
};

const SECRET_KIND_VALUES = [
  'password',
  'token',
  'server',
  'card',
  'note',
  'other',
] as const;

const SECRETS_ROOT_LABEL = 'secrets';

const secret_create: BuiltinToolDef = {
  slug: 'secret_create',
  name: 'Capture a secret',
  description:
    "Capture a sensitive value — password, PIN, API key, recovery code, anything the user explicitly says is private — into the encrypted /secrets store. ALWAYS prefer this over `note_create` or `file_create` when the user dictates a credential or asks you to remember something private; saving secrets as notes leaves them in plaintext where any future tool call can read them, while this tool seals the value with AES-256-GCM behind a key only the owner's browser session can unlock. The value is REDACTED in trace logs — never echo it back to the user; confirm by title only ('saved your safe PIN'). For multi-field secrets (e.g. a server with both username and password), the /secrets UI is still the right path; this tool handles the common one-value case.",
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'short label, e.g. "Safe PIN", "Linode root password"',
      },
      value: {
        type: 'string',
        description: 'the secret value itself — gets encrypted before storage',
      },
      kind: {
        type: 'string',
        enum: [...SECRET_KIND_VALUES],
        description: 'rough category; pick the closest match',
      },
      label: {
        type: 'string',
        description:
          "optional field label inside the secret (e.g. 'PIN', 'password'). Defaults to 'value'.",
      },
      description: {
        type: 'string',
        description: 'optional plaintext metadata visible to search (do NOT include the value here)',
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'value', 'kind'],
  },
  redactInputFields: ['value'],
  handler: async (input, ctx) => {
    const title = str(input.title).trim();
    const value = str(input.value);
    const kindRaw = str(input.kind);
    const label = str(input.label).trim() || 'value';
    const description = str(input.description).slice(0, 4000);
    const tagsIn = Array.isArray(input.tags)
      ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    if (!title) return { ok: false, error: 'title required' };
    if (!value) return { ok: false, error: 'value required' };
    const kind = (SECRET_KIND_VALUES as readonly string[]).includes(kindRaw)
      ? kindRaw
      : 'other';

    // Lazy-create the `secrets` ltree root the same way the UI does.
    await db
      .insert(nodes)
      .values({
        ownerId: ctx.ownerId,
        type: 'branch',
        title: 'Secrets',
        slug: SECRETS_ROOT_LABEL,
        path: SECRETS_ROOT_LABEL,
        data: {
          description:
            'Encrypted credentials, tokens, and other sensitive notes. Metadata is searchable; values stay sealed until you click reveal.',
        },
      })
      .onConflictDoNothing({
        target: [nodes.ownerId, nodes.path],
        where: sql`${nodes.type} = 'branch'`,
      });

    // Sanitise tags (max 20, lowercase, dedup, 40 chars each).
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const raw of tagsIn) {
      const t = raw.trim().toLowerCase();
      if (!t || t.length > 40 || seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
      if (tags.length >= 20) break;
    }

    // Insert metadata row first to get the node id (needed as AAD).
    const [inserted] = await db
      .insert(nodes)
      .values({
        ownerId: ctx.ownerId,
        type: 'secret',
        title: title.slice(0, 200),
        slug: null,
        path: SECRETS_ROOT_LABEL,
        data: {
          description,
          kind,
          has_note: false,
          field_count: 1,
        },
        tags,
      })
      .returning();
    if (!inserted) return { ok: false, error: 'failed to insert secret node' };

    // Seal the payload — single labeled field. AAD binds ciphertext to
    // this node id so an attacker who swaps the bytea column can't
    // replay another secret's ciphertext into this row.
    const payload = JSON.stringify({
      note: '',
      fields: [{ label: label.slice(0, 60), value }],
    });
    const sealed = seal(payload, `secret:${inserted.id}`);
    await db.insert(secrets).values({
      nodeId: inserted.id,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    });

    // Trace meta deliberately omits the value. setOutput is also
    // safe: only id + title + kind. Never include the value here.
    ctx.step?.setOutput({ id: inserted.id, title: inserted.title, kind });
    return {
      ok: true,
      output: {
        id: inserted.id,
        title: inserted.title,
        kind,
        message:
          "Saved to /secrets. The value is sealed — confirm by title only, do not repeat it back to the user.",
      },
    };
  },
};

const file_read: BuiltinToolDef = {
  slug: 'file_read',
  name: 'Read a file',
  description:
    "Read a file's content by id. For text files (.md / .txt / .json / .yaml) returns the body as a utf-8 string; for binaries returns a short metadata object only (no bytes). Use `node_read` for notes/events/tasks/secrets — those aren't stored in object storage.",
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

// ─── system / triggers ────────────────────────────────────────────────────

const process_extraction: BuiltinToolDef = {
  slug: 'process_extraction',
  name: 'Kick the extractor',
  description:
    "Re-fires the pg_notify('node_ingested') signal for any nodes missing data.summary or embedding. Optional `node_id` to target a single node; optional `types` to restrict by node kind; optional `limit` to cap (default 100). Idempotent — already-extracted nodes are short-circuited by the extractor.",
  inputSchema: {
    type: 'object',
    properties: {
      node_id: { type: 'string', format: 'uuid', description: 'optional single node to re-extract' },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'optional node-type filter (e.g. ["file","note"])',
      },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    },
  },
  handler: async (input, ctx) => {
    const limit = num(input.limit, 100) ?? 100;
    if (typeof input.node_id === 'string' && input.node_id) {
      // Fire for exactly one node, no eligibility check — operator chose it.
      await db.execute(sql`SELECT pg_notify('node_ingested', ${input.node_id}::text)`);
      ctx.step?.setOutput({ fired: 1, node_id: input.node_id });
      return { ok: true, output: { fired: 1, node_id: input.node_id } };
    }
    const typeFilter = Array.isArray(input.types)
      ? (input.types as string[])
      : null;
    const conds = [
      eq(nodes.ownerId, ctx.ownerId),
      sql`${nodes.type} <> 'branch'`,
      sql`${nodes.type} <> 'secret'`,
      sql`(${nodes.data}->>'summary' is null or ${nodes.embedding} is null)`,
    ];
    if (typeFilter && typeFilter.length > 0) {
      conds.push(sql`${nodes.type}::text = any(${typeFilter}::text[])`);
    }
    const rows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(...conds))
      .orderBy(desc(nodes.createdAt))
      .limit(limit);
    for (const r of rows) {
      await db.execute(sql`SELECT pg_notify('node_ingested', ${r.id}::text)`);
    }
    ctx.step?.setOutput({ fired: rows.length });
    return { ok: true, output: { fired: rows.length } };
  },
};

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

// ─── agent delegation ─────────────────────────────────────────────────────

const invoke_agent: BuiltinToolDef = {
  slug: 'invoke_agent',
  name: 'Delegate to another agent',
  description:
    "Hand off a single, self-contained prompt to another agent (e.g. a researcher with a stronger model + retrieval tools). Use only when the work would clearly benefit from a different persona or model — not for routing every turn. The child runs once and returns its final text; its conversation history is NOT shared with the parent. The parent agent's `memory_config.delegate_to` must list the target slug, or this call is refused.",
  inputSchema: {
    type: 'object',
    required: ['agent_slug', 'prompt'],
    properties: {
      agent_slug: {
        type: 'string',
        description: 'Slug of the target agent (the `agents.slug` column).',
      },
      prompt: {
        type: 'string',
        description:
          'Self-contained instructions for the child. Include any context it needs; the child does not see your conversation history.',
        maxLength: 32_000,
      },
    },
  },
  handler: async (input, ctx) => {
    // Lazy imports keep the guard module + bridge out of the cold-
    // start path of every other builtin. They're tiny but the
    // separation lets us test them as pure helpers.
    const { checkAgentDepth, checkDelegationAllowed } = await import(
      './invoke-agent-guards'
    );
    const { getAgentInvoker } = await import('./agent-bridge');

    if (!ctx.agent) {
      return {
        ok: false,
        error:
          'invoke_agent: missing parent agent context — runToolLoop did not populate ctx.agent. This is a wiring bug.',
      };
    }

    const targetSlug = str(input.agent_slug);
    const prompt = str(input.prompt);
    if (!targetSlug) return { ok: false, error: 'agent_slug is required' };
    if (!prompt) return { ok: false, error: 'prompt is required' };

    // Guardrail 3: explicit allowlist + no self-call.
    const allowed = checkDelegationAllowed(
      ctx.agent.slug,
      targetSlug,
      ctx.agent.delegateTo,
    );
    if (!allowed.ok) return { ok: false, error: allowed.reason };

    // Guardrail 1: bounded depth. checkAgentDepth returns the depth
    // the child would run at, or refuses outright.
    const depth = checkAgentDepth(ctx.agent.depth);
    if (!depth.ok) return { ok: false, error: depth.reason };

    const invoker = getAgentInvoker();
    if (!invoker) {
      return {
        ok: false,
        error:
          'invoke_agent: no agent invoker registered in this process. Call registerAgentInvoker() at boot.',
      };
    }

    // Guardrail 2: synchronous. Await the child's final result. The
    // child's cost is captured in the child's own trace; we surface
    // it in the parent step's meta for /traces visibility, but the
    // parent's `traces.cost_micro_usd` does NOT roll it up — that
    // would double-count in /debug aggregates.
    const result = await invoker({
      ownerId: ctx.ownerId,
      agentSlug: targetSlug,
      prompt,
      depth: depth.childDepth,
      parentTraceId: ctx.agent.parentTraceId ?? null,
    });
    if (!result.ok) {
      return { ok: false, error: `child agent failed: ${result.error}` };
    }
    ctx.step?.setMeta({
      child_trace_id: result.childTraceId,
      child_cost_micro_usd: result.costMicroUsd,
      child_tokens_in: result.tokensIn,
      child_tokens_out: result.tokensOut,
      delegated_to: targetSlug,
    });
    return {
      ok: true,
      output: {
        text: result.text,
        child_trace_id: result.childTraceId,
      },
    };
  },
};

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
  node_read,
  secret_create,
  file_create,
  telegram_send,
  process_extraction,
  invoke_agent,
];
