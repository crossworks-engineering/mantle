/**
 * Folder builtins for every kind whose folders are rows only (the item tree,
 * docs/folder-tree.md): notes, draw, tables, formulas, tasks, events, contacts
 * and secrets. One set for all of them, told apart by `kind`; Files keeps its
 * own folder_* tools, whose folders are real directories. Apps joined in phase 3.
 *
 * The same rules as the screens: three folder levels at most, names unique
 * per folder, a rename or move carries everything inside, deleting a folder
 * moves what it held up to its parent. System folders (Auto-filed) keep their
 * names and places.
 *
 * Owner only: a member's or client's turn is refused. The brain is the trust
 * boundary, so they sit in each kind's tool group rather than being split per
 * kind.
 */
import {
  TreeError,
  createTreeFolder,
  deleteTreeFolder,
  listTreeFolders,
  moveTreeItems,
  notifyTreeChanged,
  updateTreeFolder,
  type TreeFolderPatch,
} from '@mantle/content/tree';
import { TREE_KIND_SPECS, TREE_MAX_DEPTH, type TreeKind } from '@mantle/client-types/tree';
import { APP_TINTS, isAppTint, type AppTint } from '@mantle/client-types/app-nav';
import { projectAppIcon } from '@mantle/content-core/app-nav';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { str, strArr } from './coerce';
import { errorMessage } from '@mantle/std';
import { isOwnerSurface, OWNER_ONLY_ERROR } from './surface';
import { CONFIRM_INPUT, visibilityRefusal } from './visibility-refusal';
import { movedAppToolWarnings } from './app-tool-level';

/** The kinds these tools serve: every tree kind but Files. */
export const TREE_TOOL_KINDS = [
  'notes',
  // Pages joined the tree in folder phase 7 (a page is never a parent).
  'pages',
  'draw',
  'tables',
  'formulas',
  'tasks',
  'events',
  'contacts',
  'secrets',
  'apps',
  // Recall maps are rows too (a map is a `recall` node filed by path). No
  // other tool makes a Recall folder, and recall_map_create files into one.
  'recall',
] as const satisfies readonly TreeKind[];
type TreeToolKind = (typeof TREE_TOOL_KINDS)[number];

const KIND_PROP = {
  type: 'string',
  enum: TREE_TOOL_KINDS,
  description:
    "Which kind's folders: notes, pages, draw, tables, formulas, tasks, events, contacts, secrets, apps or recall (Recall maps). Files use the folder_* tools.",
} as const;

const FOLDER_ID_PROP = {
  type: 'string',
  format: 'uuid',
  description: "The folder's id, from `tree_folders`.",
} as const;

function kindOf(input: Record<string, unknown>): TreeToolKind | null {
  const k = str(input.kind);
  return (TREE_TOOL_KINDS as readonly string[]).includes(k ?? '') ? (k as TreeToolKind) : null;
}

/** `null`, a missing field or '' mean the top level; anything else is an id. */
function parentOf(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

/** The look fields of a folder call: an emoji or `lucide:<name>`, and a
 *  tint in APP_TINTS. Left out = untouched (undefined); null or an empty
 *  string = clear (null). A wrong value is the error to answer with. */
function lookOf(
  input: Record<string, unknown>,
): { icon?: string | null; color?: AppTint | null } | { error: string } {
  const out: { icon?: string | null; color?: AppTint | null } = {};
  if ('icon' in input) {
    const icon = str(input.icon).trim();
    if (input.icon === null || !icon) out.icon = null;
    else if (projectAppIcon(icon) === undefined) {
      return { error: 'icon must be an emoji or lucide:<name>' };
    } else out.icon = icon;
  }
  if ('color' in input) {
    const color = str(input.color).trim();
    if (input.color === null || !color) out.color = null;
    else if (!isAppTint(color)) {
      return { error: `color must be one of ${APP_TINTS.join(', ')}` };
    } else out.color = color;
  }
  return out;
}

/** The checks every call shares, then the work. */
async function run(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  work: (kind: TreeToolKind) => Promise<ToolHandlerResult>,
): Promise<ToolHandlerResult> {
  if (!isOwnerSurface(ctx.surface)) return { ok: false, error: OWNER_ONLY_ERROR };
  const kind = kindOf(input);
  if (!kind) return { ok: false, error: `kind must be one of ${TREE_TOOL_KINDS.join(', ')}` };
  try {
    return await work(kind);
  } catch (err) {
    if (err instanceof TreeError) return { ok: false, error: err.message };
    const refusal = visibilityRefusal(err);
    if (refusal) return { ok: false, error: refusal };
    return { ok: false, error: errorMessage(err) };
  }
}

export const tree_folders: BuiltinToolDef = {
  slug: 'tree_folders',
  readOnly: true,
  ownerOnly: true,
  name: 'List folders of a kind',
  description:
    `Every folder of one kind (notes, tasks, ...), in tree order: id, name, path, parent_id, depth (1 to ${TREE_MAX_DEPTH}), how many items and subfolders it holds, and whether it is a system folder (made by Mantle; its name and place are fixed). ` +
    'Items not in any folder sit at the top level, unsorted. To file items use `tree_item_move`; to make, rename or move folders use `tree_folder_create` and `tree_folder_update`.',
  inputSchema: {
    type: 'object',
    properties: { kind: KIND_PROP },
    required: ['kind'],
  },
  handler: (input, ctx) =>
    run(input, ctx, async (kind) => {
      const folders = await listTreeFolders(ctx.ownerId, kind);
      ctx.step?.setOutput({ kind, count: folders.length });
      return {
        ok: true,
        output: folders.map((f) => ({
          id: f.id,
          name: f.name,
          path: f.path,
          parent_id: f.parentId,
          depth: f.depth,
          items: f.itemCount,
          subfolders: f.folderCount,
          ...(f.system ? { system: true } : {}),
        })),
      };
    }),
};

export const tree_folder_create: BuiltinToolDef = {
  slug: 'tree_folder_create',
  ownerOnly: true,
  preconditions: [
    { kind: 'node_exists', param: 'parent_id', nodeType: 'branch', lookup: 'tree_folders' },
  ],
  name: 'Create a folder',
  description: `Create a folder for one kind (notes, tasks, ...), at the top level or inside \`parent_id\`, with an icon and a colour when asked for. Folders nest at most ${TREE_MAX_DEPTH} deep, and a name must be unique in its folder (case and punctuation do not count). Returns the folder.`,
  inputSchema: {
    type: 'object',
    properties: {
      kind: KIND_PROP,
      name: { type: 'string', minLength: 1, maxLength: 120, description: 'the name people see' },
      parent_id: {
        type: ['string', 'null'],
        description:
          'the folder to create it in, from `tree_folders`; omit or null for the top level',
      },
      icon: {
        type: 'string',
        description: 'an emoji, or `lucide:<name>` (kebab-case); omit for the default folder glyph',
      },
      color: {
        type: 'string',
        enum: [...APP_TINTS],
        description: 'the tile colour; omit for none',
      },
    },
    required: ['kind', 'name'],
  },
  handler: (input, ctx) =>
    run(input, ctx, async (kind) => {
      const name = str(input.name);
      if (!name) return { ok: false, error: 'name required' };
      const look = lookOf(input);
      if ('error' in look) return { ok: false, error: look.error };
      const folder = await createTreeFolder(ctx.ownerId, kind, {
        parentId: parentOf(input.parent_id),
        name,
        ...(look.icon ? { icon: look.icon } : {}),
        ...(look.color ? { color: look.color } : {}),
      });
      await notifyTreeChanged(ctx.ownerId, kind);
      ctx.step?.setOutput({ kind, folderId: folder.id, path: folder.path });
      return { ok: true, output: folder };
    }),
};

export const tree_folder_update: BuiltinToolDef = {
  slug: 'tree_folder_update',
  ownerOnly: true,
  name: 'Rename, move or restyle a folder',
  description:
    'Rename a folder (`name`), move it under another folder (`parent_id`; null for the top level), change its icon or colour (`icon`, `color`; null clears), or any of these together. Everything inside comes along on a move. Refused for a system folder, a move into itself, a move that would nest deeper than ' +
    `${TREE_MAX_DEPTH} levels, and a name already taken where it lands.`,
  preconditions: [
    { kind: 'node_exists', param: 'folder_id', nodeType: 'branch', lookup: 'tree_folders' },
    { kind: 'node_exists', param: 'parent_id', nodeType: 'branch', lookup: 'tree_folders' },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      kind: KIND_PROP,
      folder_id: FOLDER_ID_PROP,
      name: { type: 'string', minLength: 1, maxLength: 120, description: 'the new name' },
      parent_id: {
        type: ['string', 'null'],
        description:
          'move it into this folder; null for the top level; omit to leave it where it is',
      },
      icon: {
        type: ['string', 'null'],
        description: 'an emoji, or `lucide:<name>` (kebab-case); null for the default glyph',
      },
      color: {
        type: ['string', 'null'],
        enum: [...APP_TINTS, null],
        description: 'the tile colour; null for none',
      },
      confirm: CONFIRM_INPUT,
    },
    required: ['kind', 'folder_id'],
  },
  handler: (input, ctx) =>
    run(input, ctx, async (kind) => {
      const folderId = str(input.folder_id);
      if (!folderId) return { ok: false, error: 'folder_id required' };
      const patch: TreeFolderPatch = {};
      const name = str(input.name);
      if (name) patch.name = name;
      if ('parent_id' in input) patch.parentId = parentOf(input.parent_id);
      const look = lookOf(input);
      if ('error' in look) return { ok: false, error: look.error };
      if (look.icon !== undefined) patch.icon = look.icon;
      if (look.color !== undefined) patch.color = look.color;
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: 'pass `name`, `parent_id`, `icon` or `color` (any of them)' };
      }
      const folder = await updateTreeFolder(ctx.ownerId, kind, folderId, patch, {
        confirm: input.confirm === true,
      });
      await notifyTreeChanged(ctx.ownerId, kind);
      ctx.step?.setOutput({ kind, folderId, path: folder.path });
      return { ok: true, output: folder };
    }),
};

export const tree_item_move: BuiltinToolDef = {
  slug: 'tree_item_move',
  ownerOnly: true,
  preconditions: [
    { kind: 'node_exists', param: 'folder_id', nodeType: 'branch', lookup: 'tree_folders' },
  ],
  name: 'File items into a folder',
  description:
    'Move items of one kind (note, task, table, ... ids) into a folder (`folder_id` from `tree_folders`), or to the top level with null. Only where the item sits changes: its content, level and last-changed date stay. Each item moves on its own; the result lists any that could not.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: KIND_PROP,
      item_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        maxItems: 200,
        description: 'the items to move, all of this kind',
      },
      folder_id: {
        type: ['string', 'null'],
        description: 'the destination folder; null for the top level',
      },
      confirm: CONFIRM_INPUT,
    },
    required: ['kind', 'item_ids', 'folder_id'],
  },
  handler: (input, ctx) =>
    run(input, ctx, async (kind) => {
      const ids = strArr(input.item_ids);
      if (!ids.length) return { ok: false, error: 'item_ids required' };
      const result = await moveTreeItems(ctx.ownerId, kind, ids, parentOf(input.folder_id), {
        confirm: input.confirm === true,
      });
      if (result.moved) await notifyTreeChanged(ctx.ownerId, kind);
      ctx.step?.setOutput({ kind, moved: result.moved, failed: result.failed.length });
      if (!result.moved && result.failed.length) {
        const noun = TREE_KIND_SPECS[kind].nodeType;
        return {
          ok: false,
          error: `nothing moved: ${result.failed[0]!.error} (each id must be a ${noun} of this brain)`,
        };
      }
      // An app's folder can set the level it is used at (a client-shared
      // folder, M5): say which declared tools its runs now refuse (N11).
      if (kind === 'apps' && result.moved) {
        const failed = new Set(result.failed.map((f) => f.id));
        const warnings = await movedAppToolWarnings(
          ctx.ownerId,
          [...new Set(ids)].filter((id) => !failed.has(id)),
        );
        if (warnings.length) return { ok: true, output: { ...result, warnings } };
      }
      return { ok: true, output: result };
    }),
};

export const tree_folder_delete: BuiltinToolDef = {
  slug: 'tree_folder_delete',
  mcpOnly: true,
  ownerOnly: true,
  name: 'Delete a folder',
  description:
    'Delete a folder of one kind. What it holds (items and subfolders) moves up to its parent first; nothing inside is deleted. A subfolder whose name is already taken there merges into that folder (which keeps its name, look and share); items keep their titles. Refused for system folders.',
  preconditions: [
    { kind: 'node_exists', param: 'folder_id', nodeType: 'branch', lookup: 'tree_folders' },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      kind: KIND_PROP,
      folder_id: FOLDER_ID_PROP,
      confirm: CONFIRM_INPUT,
    },
    required: ['kind', 'folder_id'],
  },
  handler: (input, ctx) =>
    run(input, ctx, async (kind) => {
      const folderId = str(input.folder_id);
      if (!folderId) return { ok: false, error: 'folder_id required' };
      await deleteTreeFolder(ctx.ownerId, kind, folderId, { confirm: input.confirm === true });
      await notifyTreeChanged(ctx.ownerId, kind);
      ctx.step?.setOutput({ kind, folderId });
      return {
        ok: true,
        output:
          'deleted; what it held moved up to its parent, merging into any folder of the same name there',
      };
    }),
};

/** Offered to agents through each kind's tool group. */
export const TREE_TOOLS: BuiltinToolDef[] = [
  tree_folders,
  tree_folder_create,
  tree_folder_update,
  tree_item_move,
];

/** Operator surface (MCP only), like Files' folder_delete. */
export const TREE_OPERATOR_TOOLS: BuiltinToolDef[] = [tree_folder_delete];
