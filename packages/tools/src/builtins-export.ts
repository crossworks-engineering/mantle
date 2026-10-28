/**
 * Export builtins — render a content node to an Office document and save it
 * where an export lands (@mantle/files saveExport: Auto-filed / Exports for
 * an Admin user). The rendering itself (and the page/note/table → format
 * mapping) lives in `@mantle/content`'s `resolveExport`, the same code the web
 * `/api/export/[id]` download button uses. Page images are embedded by reading
 * their bytes from the file store via the injected `loadImage` callback.
 *
 * An embedded DRAWING: Word takes no SVG, so the snapshot is rastered. The
 * documents engine does it (a screenshot of /print/draws/<id> at 2x,
 * packages/documents) when the `documents` service is on and the call has a
 * login actor (the render cookie names it); otherwise the drawing degrades
 * to `[drawing: alt]`, as it always did here: the browser sidecar is
 * reachable only from `server/web`, and this package is imported by every
 * process that runs a tool loop. See docs/draw.md §9.
 */
import { resolveExport } from '@mantle/content';
import { currentActor } from '@mantle/db';
import { documentsAvailable, pngSize, runDocuments } from '@mantle/documents';
import { readFileById, saveExport } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef, ToolPrecondition } from './types';
import { str } from './coerce';
import { errorMessage } from '@mantle/std';
import { CS } from './client-sourced-rule';
import { EXPORT_FORMAT_BY_KIND } from '@mantle/client-types/kind-lists';
import type { ItemKind } from '@mantle/client-types/kinds';

/** The kinds an export makes a file of (the registry's). */
const EXPORT_KINDS = Object.keys(EXPORT_FORMAT_BY_KIND) as ItemKind[];

// Referential precondition (checked centrally in dispatch — see
// preconditions.ts): the id must name an existing node the owner holds.
// No nodeType — exportable nodes span pages, notes, and tables; the
// handler's resolveExport rejects non-exportable types itself.
const NODE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'node_id', lookup: 'search_nodes / tree_list' },
];

/** The raster of a drawing the engine makes (DRAW_PIXEL_RATIO times its CSS
 *  size), sized at 1x for the document; null when the engine is off, the
 *  call has no login, or the drawing has nothing to show. Never throws:
 *  the export degrades to the placeholder. */
const DRAW_PIXEL_RATIO = 2;
async function drawRaster(
  ownerId: string,
  drawId: string,
): Promise<{ bytes: Buffer; width: number; height: number } | null> {
  const actor = currentActor();
  if (!documentsAvailable() || actor?.kind !== 'login') return null;
  try {
    const res = await runDocuments(
      {
        route: 'chromium/screenshot/url',
        inputs: { node_id: drawId },
        options: { deviceScaleFactor: DRAW_PIXEL_RATIO, width: 800, height: 1000, format: 'png' },
      },
      { ownerId, actorLoginId: actor.loginId },
      'bytes',
    );
    if (res.kind !== 'bytes') return null;
    const size = pngSize(res.bytes);
    if (!size) return null;
    return {
      bytes: res.bytes,
      width: Math.round(size.width / DRAW_PIXEL_RATIO),
      height: Math.round(size.height / DRAW_PIXEL_RATIO),
    };
  } catch {
    return null;
  }
}

const export_node: BuiltinToolDef = {
  slug: 'export_node',
  usageTier: 2,
  policy: {
    matrix: { action: 'read', param: 'node_id', kinds: EXPORT_KINDS },
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    clientSourced: CS.creates(),
    // Audit only: the row names it (the queue asks nothing of it).
    itemArgs: [{ param: 'node_id', least: 'none' }],
  },
  name: 'Export to Word / Excel',
  description:
    "Render a page or note to a Word (.docx) document, or a table to an Excel (.xlsx) spreadsheet, and save it in Auto-filed / Exports / <month> when the caller may change it (the owner or an Admin Moderator), else the top of Files. A taken name gets a `-2` suffix. The format is chosen automatically from the node type — pages/notes → Word, tables → Excel. Pages keep their headings, lists, tables, callouts and images; tables export typed cells (currency/number/percent/checkbox) plus the totals row. Returns the new file's id, name, path and landedIn. Use this when the user asks to download, export, or 'get a Word/Excel copy' of a page, note, or table.",
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: 'id of the page, note, or table to export',
      },
      filename: {
        type: 'string',
        description:
          'optional output filename (without folder). The extension is forced to match the chosen format (.docx/.xlsx).',
      },
    },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    const nodeId = str(input.node_id).trim();
    if (!nodeId) return { ok: false, error: 'node_id is required' };

    let result;
    try {
      result = await resolveExport(ctx.ownerId, nodeId, {
        loadImage: async (fileId) => {
          const res = await readFileById({ ownerId: ctx.ownerId, fileId });
          return res ? { bytes: res.bytes } : null;
        },
        loadDraw: (drawId) => drawRaster(ctx.ownerId, drawId),
      });
    } catch (err) {
      return {
        ok: false,
        error: `export failed: ${errorMessage(err)}`,
      };
    }
    if (!result) {
      return {
        ok: false,
        error: `node ${nodeId} not found, or it isn't an exportable page/note/table`,
      };
    }

    // Honour a caller-supplied name but force the correct extension.
    const override = str(input.filename).trim();
    const filename = override
      ? `${override.replace(/\.(docx|xlsx)$/i, '')}.${result.format}`
      : result.filename;

    try {
      const { file, landedIn } = await saveExport({
        ownerId: ctx.ownerId,
        filename,
        bytes: result.bytes,
      });
      ctx.step?.setOutput({ file_id: file.id, filename: file.filename, kind: result.kind });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: file.id,
        summary: `Exported ${result.kind} "${result.title}" to ${result.format.toUpperCase()}: ${file.filename}`,
        payload: {
          via: 'export_node_tool',
          sourceNodeId: nodeId,
          format: result.format,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
      });
      return {
        ok: true,
        output: {
          file_id: file.id,
          filename: file.filename,
          path: `${file.parentPath}/${file.filename}`,
          format: result.format,
          kind: result.kind,
          size_bytes: file.sizeBytes,
          ...(landedIn ? { landedIn } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const EXPORT_TOOLS: BuiltinToolDef[] = [export_node];
