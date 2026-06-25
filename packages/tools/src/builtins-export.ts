/**
 * Export builtins — render a content node to an Office document and save it
 * under /files/exports. The rendering itself (and the page/note/table → format
 * mapping) lives in `@mantle/content`'s `resolveExport`, the same code the web
 * `/api/export/[id]` download button uses, so the assistant and the UI produce
 * identical files. Page images are embedded by reading their bytes from the
 * file store via the injected `loadImage` callback.
 */
import { resolveExport } from '@mantle/content';
import { ensureDatedUploadFolder, readFileById, upsertFile } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const export_node: BuiltinToolDef = {
  slug: 'export_node',
  name: 'Export to Word / Excel',
  description:
    "Render a page or note to a Word (.docx) document, or a table to an Excel (.xlsx) spreadsheet, and save it under /files/exports/<date>. The format is chosen automatically from the node type — pages/notes → Word, tables → Excel. Pages keep their headings, lists, tables, callouts and images; tables export typed cells (currency/number/percent/checkbox) plus the totals row. Returns the new file's id, name, and path. Use this when the user asks to download, export, or 'get a Word/Excel copy' of a page, note, or table.",
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
      });
    } catch (err) {
      return { ok: false, error: `export failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!result) {
      return { ok: false, error: `node ${nodeId} not found, or it isn't an exportable page/note/table` };
    }

    // Honour a caller-supplied name but force the correct extension.
    const override = str(input.filename).trim();
    const filename = override
      ? `${override.replace(/\.(docx|xlsx)$/i, '')}.${result.format}`
      : result.filename;

    try {
      const parentPath = await ensureDatedUploadFolder({
        ownerId: ctx.ownerId,
        topSlug: 'exports',
        topDescription: 'Documents exported from pages, notes, and tables.',
      });
      const file = await upsertFile({ ownerId: ctx.ownerId, parentPath, filename, bytes: result.bytes });
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
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const EXPORT_TOOLS: BuiltinToolDef[] = [export_node];
