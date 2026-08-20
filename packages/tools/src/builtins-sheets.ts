/**
 * Spreadsheet-authoring builtins — `sheet_build`.
 *
 * The agent describes a workbook; this writes a styled .xlsx under /files and
 * returns the new file's id. The rendering (and every visual decision) lives in
 * `@mantle/content`'s `buildSheet`, which shares its palette with the table
 * export, so a spreadsheet an agent composes and one a person downloads look
 * like they came from the same place.
 *
 * **Not a replacement for `table_create`.** A table is data you query — typed,
 * stored, addressable by row id, editable later. A sheet is a document you
 * send. The tool description below says the same thing to the model, because
 * the wrong choice here is the expensive one: an agent that builds a file when
 * the user wanted a table leaves them nothing to filter or add a row to.
 */
import { buildSheet, SheetSpecError, type SheetSpec, type WorkbookSpec } from '@mantle/content';
import { ensureDatedUploadFolder, upsertFile } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';

const sheet_build: BuiltinToolDef = {
  slug: 'sheet_build',
  name: 'Build a spreadsheet',
  description:
    "Compose a formatted Excel (.xlsx) workbook from data you already hold and save it under /files; returns the file id, name and path. For a spreadsheet that IS the deliverable: a quote, a costing, a report pack. Header, column widths, number formats and totals are styled for you.\n\n**Sheet or table?** A table is data the user keeps querying and adding rows to; for that use `table_create`, or `table_from_file` to import one. Use this when they asked to be SENT a spreadsheet. Past a few thousand rows, build a table instead.\n\nRows are objects keyed by each column's `key`; a positional array is rejected, because one omitted value shifts every column after it.",
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          "Output filename, e.g. 'q1-board-pack.xlsx'. The .xlsx extension is added if missing.",
      },
      sheets: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        description: 'One entry per worksheet, in the order they should appear.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'Tab name. Excel caps these at 31 characters and forbids \\ / ? * [ ] : — both are handled for you, and duplicates get a numeric suffix.',
            },
            title: {
              type: 'string',
              description:
                'Optional bold heading written in a row above the table, with a blank spacer row between. Use it when the sheet is a document rather than a data dump.',
            },
            style: {
              type: 'string',
              enum: ['report', 'plain', 'compact'],
              description:
                "'report' (default) — slate header, banded rows, ruled totals; for anything going to another person. 'plain' — bold header, no fills; for a sheet the recipient will re-style or pivot. 'compact' — like report without the banding; for dense reference data.",
            },
            columns: {
              type: 'array',
              minItems: 1,
              maxItems: 64,
              description: 'The columns, left to right. Each needs a `key` and a `header`.',
              items: {
                type: 'object',
                properties: {
                  key: {
                    type: 'string',
                    description: "Stable key each row is keyed by, e.g. 'amount'.",
                  },
                  header: {
                    type: 'string',
                    description: "The visible column name, e.g. 'Amount'.",
                  },
                  type: {
                    type: 'string',
                    enum: [
                      'text',
                      'number',
                      'currency',
                      'percent',
                      'date',
                      'datetime',
                      'boolean',
                      'url',
                    ],
                    description:
                      "Defaults to 'text'. ALWAYS type money as 'currency' and rates as 'percent' — a number left as text cannot be summed by the reader. Dates become real date cells formatted yyyy-mm-dd.",
                  },
                  format: {
                    type: 'object',
                    description: 'Number presentation for a number/currency/percent column.',
                    properties: {
                      currency: {
                        type: 'string',
                        description:
                          "Currency code shown in the cell, e.g. 'ZAR'. Defaults to USD.",
                      },
                      decimals: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 6,
                        description: 'Decimal places for a number/currency/percent column.',
                      },
                    },
                  },
                  align: {
                    type: 'string',
                    enum: ['left', 'right', 'center'],
                    description:
                      'Overrides the alignment the type would choose. Rarely needed — numbers already go right and text left.',
                  },
                  width: {
                    type: 'number',
                    description:
                      'Fixed width in Excel character units. Omit to size the column from its contents, which is almost always better.',
                  },
                },
                required: ['key', 'header'],
              },
            },
            rows: {
              type: 'array',
              maxItems: 5000,
              description:
                'One object per row, keyed by column `key` — e.g. { "client": "Acme", "amount": 4820.5 }. NOT positional arrays. Omit a key for a blank cell; an unrecognised key is an error.',
              items: { type: 'object' },
            },
            totals: {
              type: 'object',
              description:
                "Column key → 'sum' | 'avg' | 'count' | 'min' | 'max'. Rendered as a bold, ruled row under the data. Use this rather than appending a hand-computed totals row — a hand-written total is not a formula, is not labelled, and gets sorted into the data the first time someone filters.",
            },
            freeze_columns: {
              type: 'integer',
              minimum: 0,
              description:
                'Freeze this many leading columns alongside the header, so labels stay visible when a wide sheet scrolls right.',
            },
          },
          required: ['name', 'columns', 'rows'],
        },
      },
    },
    required: ['filename', 'sheets'],
  },
  handler: async (input, ctx) => {
    const rawName = str(input.filename).trim();
    if (!rawName) return { ok: false, error: 'filename is required' };
    // Strip any folder the model prefixed; the destination is ours to choose.
    const base = rawName
      .split('/')
      .pop()!
      .replace(/\.xlsx$/i, '');
    if (!base) return { ok: false, error: 'filename is required' };
    const filename = `${base}.xlsx`;

    const sheets = input.sheets;
    if (!Array.isArray(sheets)) return { ok: false, error: 'sheets must be an array' };
    const spec: WorkbookSpec = { sheets: sheets as SheetSpec[] };

    let bytes: Buffer;
    try {
      bytes = await buildSheet(spec);
    } catch (err) {
      // A spec error is the agent's to fix, and its message names the sheet and
      // key at fault — pass it through verbatim rather than flattening it.
      if (err instanceof SheetSpecError) return { ok: false, error: err.message };
      return {
        ok: false,
        error: `sheet build failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const parentPath = await ensureDatedUploadFolder({
        ownerId: ctx.ownerId,
        topSlug: 'exports',
        topDescription: 'Documents exported from pages, notes, and tables.',
      });
      const file = await upsertFile({ ownerId: ctx.ownerId, parentPath, filename, bytes });
      ctx.step?.setOutput({ file_id: file.id, filename: file.filename });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: file.id,
        summary: `Spreadsheet built by tool: ${file.filename}`,
        payload: {
          via: 'sheet_build_tool',
          sheets: spec.sheets.length,
          rows: spec.sheets.reduce((n, s) => n + (s.rows?.length ?? 0), 0),
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
      });
      return {
        ok: true,
        output: {
          file_id: file.id,
          filename: file.filename,
          path: `${file.parentPath}/${file.filename}`,
          size_bytes: file.sizeBytes,
          sheets: spec.sheets.map((s) => ({
            name: s.name,
            columns: s.columns.length,
            rows: s.rows?.length ?? 0,
          })),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const SHEET_TOOLS: BuiltinToolDef[] = [sheet_build];
export const SHEET_TOOL_SLUGS = SHEET_TOOLS.map((t) => t.slug);
