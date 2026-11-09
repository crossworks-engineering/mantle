/**
 * The documents engine's four tools (packages/documents, docs/documents.md):
 * pdf_render (Chromium: HTML, markdown or a page of this brain to PDF),
 * screenshot_render (the same to a picture), office_to_pdf (LibreOffice) and
 * pdf_tools (`op` picks the PDF-engine route: merge, split, flatten,
 * convert, metadata, encrypt, embed, watermark, stamp, rotate, bookmarks,
 * optimize, factur-x). Four tools keep an agent's list short; every option
 * is the engine's own field name, so the Gotenberg docs are the docs.
 *
 * Policy like export_node: effect write (a file lands by the export rules),
 * spends none, not mcpOnly (the `documents` manifest group grants them).
 * The `documents` service gates them: off, an agent's list leaves them out
 * (toolServiceAvailable) and MCP answers that the service is switched off.
 * A page print carries a render cookie for the acting login (the print
 * surface asks an Admin login of it); a call with no login actor converts
 * files and inline text only.
 *
 * Mini apps (docs/app-authoring-guide.md, "Reports"): an app the Admin
 * workspace alone holds runs them as the admin, and the file lands where an
 * admin's export lands. A team app (team rules, member-app-tools.ts) may
 * call them too (policy memberApp 'documents'): its inputs are read with
 * the runner's own rights, it prints HTML, markdown or files, never a page
 * of the brain (`node_id`), and its file lands where the runner's own
 * export lands, as by hand (teamAppSaveRefusal; owner decision 2026-11-09),
 * indexed by its metadata only (no model reads it: a loop of saves starts no
 * extraction or summary, only the embedding of its name and folder). Any app may
 * pass `bytes: true` instead: nothing is saved, and the PDF or picture
 * comes back as base64 within the caps of file_read's bytes (app-bytes.ts).
 */
import { registerToolService } from '@mantle/config';
import { currentActor, inAppRunWrite } from '@mantle/db';
import {
  findRoute,
  runDocuments,
  type DocumentsCall,
  type DocumentsResult,
} from '@mantle/documents';
import { errorMessage } from '@mantle/std';
import { recordIngest } from '@mantle/tracing';
import {
  APP_BYTES_BUSY,
  APP_BYTES_MAX,
  appBytesRefusal,
  appBytesTooLarge,
  withAppBytesSlot,
} from './app-bytes';
import { CS } from './client-sourced-rule';
import { boolOpt as bool } from './coerce';
import { currentToolCaller } from './gate-callers';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import type { ToolPolicy } from './tool-policy';

const POLICY: ToolPolicy = {
  matrix: { none: 'a create naming no folder: it lands by the export rule (saveExport)' },
  effect: 'write',
  spends: 'none',
  scope: 'any',
  creates: 'file',
  clientSourced: CS.creates(),
  memberApp: 'documents',
};

/** Why a team app may not print `node_id`. */
export const TEAM_APP_NO_NODE_PRINT =
  "A team app can't print a page or a drawing of the brain (node_id): print HTML or markdown the app builds, or convert files with file_ids.";

/**
 * Why a team app's call may not save its file, or null: it saves only in a
 * run that may write (the broker's write, as the running login in that
 * login's own scope, inAppRunWrite). The file then lands where that user's
 * own export lands (export-home.ts: the call's workspace when they moderate
 * it, else their private workspace; an Admin user's, Auto-filed), as by
 * hand. Else nothing is saved, and the refusal says to pass `bytes: true`.
 * Exported for tests.
 */
export function teamAppSaveRefusal(): string | null {
  if (inAppRunWrite()) return null;
  return "This run can't save a file: a team app saves only in a request that may write, as a login that writes (not a read-only key). Pass bytes: true to get the file back in the app instead (nothing is saved).";
}

const INPUT_PROPERTIES = {
  file_ids: {
    type: 'array',
    items: { type: 'string', format: 'uuid' },
    description: 'The files to work on (file_list, search), e.g. ["<file id>"].',
  },
  options: {
    type: 'object',
    additionalProperties: true,
    description:
      'The engine\'s own fields (https://gotenberg.dev/docs/routes), e.g. {"landscape": true, "pdfa": "PDF/A-2b"}. An unknown field is refused by name; url, cookies, headers and the raw file fields are the brain\'s own.',
  },
  filename: {
    type: 'string',
    description: "The output name's stem, e.g. 'q3-pack' (the extension follows the output).",
  },
  bytes: {
    type: 'boolean',
    description:
      'Mini apps only: hand the PDF or picture back as base64 and save nothing, e.g. to show or download it in the app.',
  },
} as const;

const CHROMIUM_INPUTS = {
  node_id: {
    type: 'string',
    format: 'uuid',
    description: 'A page or a drawing of this brain to print (page_list, draw_list, search).',
  },
  html: {
    type: 'string',
    description: 'A full HTML document to render (4 MB at most), instead of node_id.',
  },
  markdown: {
    type: 'string',
    description: 'Markdown to render (4 MB at most), instead of node_id or html.',
  },
  asset_file_ids: {
    type: 'array',
    items: { type: 'string', format: 'uuid' },
    description: 'Images, CSS or fonts the html references by their own file names.',
  },
} as const;

/** The acting login for a render cookie: the actor when it is a login. */
function actorLoginId(): string | null {
  const actor = currentActor();
  return actor?.kind === 'login' ? actor.loginId : null;
}

function output(result: DocumentsResult): Record<string, unknown> {
  if (result.kind === 'json') return { route: result.route, result: result.json };
  if (result.kind === 'bytes') return { route: result.route, filename: result.filename };
  const f = result.file;
  return {
    route: result.route,
    file_id: f.id,
    filename: f.name,
    path: f.path,
    size_bytes: f.sizeBytes,
    mime_type: f.mimeType,
    ...(f.landedIn ? { landedIn: f.landedIn } : {}),
  };
}

/** A result handed back to a mini app (`bytes: true`): the bytes as base64
 *  (the caller checked file_read's cap). */
function bytesOutput(result: DocumentsResult & { kind: 'bytes' }): ToolHandlerResult {
  return {
    ok: true,
    output: {
      route: result.route,
      filename: result.filename,
      mime_type: result.contentType,
      size_bytes: result.bytes.length,
      content_base64: result.bytes.toString('base64'),
    },
  };
}

async function run(
  ctx: ToolHandlerContext,
  input: Record<string, unknown>,
  call: DocumentsCall,
  what: string,
): Promise<ToolHandlerResult> {
  const wantsBytes = bool(input.bytes) === true;
  if (wantsBytes) {
    const refused = appBytesRefusal(ctx);
    if (refused) return { ok: false, error: refused };
  }
  const caller = { ownerId: ctx.ownerId, actorLoginId: actorLoginId() };
  // An app's run at team rules (fail closed: any app rules but admin's; a
  // shared link runs no built-in at all): no page print, and a file only in
  // a run that may write (see the module comment).
  const by = ctx.caller ?? currentToolCaller();
  const team = by?.entry === 'app' && by.appRules !== 'admin';
  if (team && typeof input.node_id === 'string' && input.node_id) {
    return { ok: false, error: TEAM_APP_NO_NODE_PRINT };
  }
  // The two read routes (pdf_tools metadata_read, bookmarks_read) answer
  // JSON and save nothing: no home to ask for.
  const saves = !wantsBytes && findRoute(call.route)?.output !== 'json';
  if (team && saves) {
    const refused = teamAppSaveRefusal();
    if (refused) return { ok: false, error: refused };
  }
  // One call of the engine: the bytes handed back (`bytes: true`), or the
  // file landed. A team app's file lands where the runner's own export
  // lands, and is indexed by its metadata only: a loop of saves starts no
  // model work.
  const convert = async (): Promise<DocumentsResult | { error: string }> => {
    try {
      if (wantsBytes) return await runDocuments(call, caller, 'bytes');
      return team && saves
        ? await runDocuments({ ...call, indexing: 'metadata' }, caller)
        : await runDocuments(call, caller);
    } catch (err) {
      return { error: errorMessage(err) };
    }
  };
  if (wantsBytes) {
    const result = await convert();
    if ('error' in result) return { ok: false, error: result.error };
    if (result.kind !== 'bytes') return { ok: true, output: output(result) };
    if (result.bytes.length > APP_BYTES_MAX) {
      return { ok: false, error: appBytesTooLarge(result.filename, result.bytes.length) };
    }
    // A slot only for the base64 copy, so a slow engine job never holds
    // one that a picture read waits for (app-bytes.ts).
    const done = await withAppBytesSlot(async (): Promise<ToolHandlerResult> => {
      ctx.step?.setOutput({ route: result.route, bytes: result.bytes.length });
      return bytesOutput(result);
    });
    return done ?? { ok: false, error: APP_BYTES_BUSY };
  }
  const result = await convert();
  if ('error' in result) return { ok: false, error: result.error };
  if (result.kind === 'file') {
    ctx.step?.setOutput({
      file_id: result.file.id,
      filename: result.file.name,
      route: result.route,
    });
    void recordIngest({
      source: 'agent_tool',
      ownerId: ctx.ownerId,
      nodeId: result.file.id,
      summary: `${what}: ${result.file.name}`,
      payload: {
        via: 'documents_tool',
        route: result.route,
        ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
      },
    });
  }
  return { ok: true, output: output(result) };
}

/** The inputs a tool's arguments carry, as the package reads them. */
function inputsOf(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'file_ids',
    'node_id',
    'html',
    'markdown',
    'asset_file_ids',
    'header_html',
    'footer_html',
    'watermark_file_id',
    'stamp_file_id',
    'facturx_file_id',
    'embed_file_ids',
  ]) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  return out;
}

/** Which Chromium source the arguments name: a node, html or markdown. */
function chromiumSource(input: Record<string, unknown>): 'url' | 'html' | 'markdown' {
  if (typeof input.node_id === 'string' && input.node_id) return 'url';
  if (typeof input.markdown === 'string' && input.markdown && !input.html) return 'markdown';
  return 'html';
}

const options = (input: Record<string, unknown>) =>
  input.options && typeof input.options === 'object'
    ? (input.options as Record<string, unknown>)
    : {};
const filename = (input: Record<string, unknown>) =>
  typeof input.filename === 'string' ? input.filename : undefined;

// Referential precondition (checked centrally in dispatch, preconditions.ts):
// a node_id, when given, must name an existing node the caller holds; the
// package then asks that it is a page or a drawing.
const NODE_ID_PRE = [
  { kind: 'node_exists', param: 'node_id', lookup: 'page_list / draw_list / search_nodes' },
] as const;

const pdf_render: BuiltinToolDef = {
  slug: 'pdf_render',
  usageTier: 2,
  policy: POLICY,
  preconditions: NODE_ID_PRE,
  name: 'Render to PDF',
  description:
    'Print a page or a drawing of this brain (`node_id`), or HTML or markdown you wrote, to a PDF through the documents engine and save it where an export lands (Auto-filed / Exports for an Admin user, else the top of Files). Returns the file id, name, path and landedIn. Options are the engine\'s fields: paper size and margins, `landscape`, `printBackground`, `pdfa`, `metadata`; `header_html` and `footer_html` print on every page with `<span class="pageNumber">` and `totalPages`. Use when the user wants a PDF or a report. For Word or Excel use `export_node`; for an Office file use `office_to_pdf`.',
  inputSchema: {
    type: 'object',
    properties: {
      ...CHROMIUM_INPUTS,
      header_html: {
        type: 'string',
        description: 'A full HTML document printed at the top of every page.',
      },
      footer_html: {
        type: 'string',
        description: 'A full HTML document printed at the bottom of every page.',
      },
      ...INPUT_PROPERTIES,
    },
  },
  handler: async (input, ctx) =>
    run(
      ctx,
      input,
      {
        route: `chromium/convert/${chromiumSource(input)}`,
        inputs: inputsOf(input),
        options: options(input),
        filename: filename(input),
      },
      'Rendered to PDF',
    ),
};

const screenshot_render: BuiltinToolDef = {
  slug: 'screenshot_render',
  usageTier: 2,
  policy: POLICY,
  preconditions: NODE_ID_PRE,
  name: 'Render to a picture',
  description:
    "Take a picture (PNG, JPEG or WebP) of a page or a drawing of this brain (`node_id`), or of HTML or markdown you wrote, through the documents engine, and save it where an export lands. Returns the file id, name, path and landedIn. Options are the engine's fields: `width`, `height`, `selector` (clip to one element), `deviceScaleFactor` (2 for a sharp picture), `format`, `quality`. For a PDF use `pdf_render`.",
  inputSchema: {
    type: 'object',
    properties: { ...CHROMIUM_INPUTS, ...INPUT_PROPERTIES },
  },
  handler: async (input, ctx) =>
    run(
      ctx,
      input,
      {
        route: `chromium/screenshot/${chromiumSource(input)}`,
        inputs: inputsOf(input),
        options: options(input),
        filename: filename(input),
      },
      'Rendered to a picture',
    ),
};

const office_to_pdf: BuiltinToolDef = {
  slug: 'office_to_pdf',
  usageTier: 2,
  policy: POLICY,
  name: 'Office file to PDF',
  description:
    "Convert Office files (Word, Excel, PowerPoint, OpenDocument, RTF, text, images and more; `file_ids`) to PDF through the documents engine (LibreOffice) and save the PDF where an export lands; several files give a zip, or one PDF with `merge: true`. Returns the file id, name, path and landedIn. Options are the engine's fields: `landscape`, `nativePageRanges`, `password` (a protected source), `pdfa`, `exportFormFields`. For a page of this brain use `pdf_render`.",
  inputSchema: {
    type: 'object',
    properties: INPUT_PROPERTIES,
    required: ['file_ids'],
  },
  handler: async (input, ctx) =>
    run(
      ctx,
      input,
      {
        route: 'libreoffice/convert',
        inputs: inputsOf(input),
        options: options(input),
        filename: filename(input),
      },
      'Converted to PDF',
    ),
};

/** The PDF-engine ops, in the tool's words, to the route key. */
export const PDF_TOOL_OPS: Readonly<Record<string, string>> = {
  merge: 'pdfengines/merge',
  split: 'pdfengines/split',
  flatten: 'pdfengines/flatten',
  convert: 'pdfengines/convert',
  metadata_read: 'pdfengines/metadata/read',
  metadata_write: 'pdfengines/metadata/write',
  encrypt: 'pdfengines/encrypt',
  embed: 'pdfengines/embed',
  watermark: 'pdfengines/watermark',
  stamp: 'pdfengines/stamp',
  rotate: 'pdfengines/rotate',
  bookmarks_read: 'pdfengines/bookmarks/read',
  bookmarks_write: 'pdfengines/bookmarks/write',
  optimize: 'pdfengines/optimize',
  factur_x: 'pdfengines/factur-x',
};

const pdf_tools: BuiltinToolDef = {
  slug: 'pdf_tools',
  usageTier: 2,
  policy: POLICY,
  name: 'PDF tools',
  description:
    "Work on PDFs (`file_ids`) through the documents engine: `op` merge, split, flatten, convert (PDF/A, PDF/UA), metadata_read, metadata_write, encrypt, embed (attach files), watermark, stamp, rotate, bookmarks_read, bookmarks_write, optimize, factur_x. The result lands where an export lands and comes back as file id, name, path and landedIn; metadata_read and bookmarks_read answer JSON and save nothing. Options are the engine's fields for that op (`splitMode` and `splitSpan`, `pdfa`, `userPassword`, `watermarkSource` and `watermarkExpression`, `rotateAngle`, `metadata`, `bookmarks`). To make a PDF first use `pdf_render` or `office_to_pdf`.",
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: Object.keys(PDF_TOOL_OPS),
        description: "The operation, e.g. 'merge'.",
      },
      ...INPUT_PROPERTIES,
      watermark_file_id: {
        type: 'string',
        format: 'uuid',
        description: 'The image or PDF used as the watermark (op watermark).',
      },
      stamp_file_id: {
        type: 'string',
        format: 'uuid',
        description: 'The image or PDF used as the stamp (op stamp).',
      },
      facturx_file_id: {
        type: 'string',
        format: 'uuid',
        description: 'The Factur-X invoice XML (op factur_x or embed).',
      },
      embed_file_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Files to attach inside the PDF (op embed).',
      },
    },
    required: ['op', 'file_ids'],
  },
  handler: async (input, ctx) => {
    const op = typeof input.op === 'string' ? input.op : '';
    const route = PDF_TOOL_OPS[op];
    if (!route) {
      return {
        ok: false,
        error: `op '${op}' is not a PDF tool; the ops are ${Object.keys(PDF_TOOL_OPS).join(', ')}`,
      };
    }
    return run(
      ctx,
      input,
      { route, inputs: inputsOf(input), options: options(input), filename: filename(input) },
      `PDF ${op}`,
    );
  },
};

export const DOCUMENT_TOOLS: BuiltinToolDef[] = [
  pdf_render,
  screenshot_render,
  office_to_pdf,
  pdf_tools,
];

/** Name the service each of the four needs with the config's gate
 *  (toolService), so an agent's list leaves them out while the service is
 *  off. Called where the tools join the registry (builtins.ts), so any
 *  process that lists builtins has the gate. */
export function registerDocumentToolServices(): void {
  for (const t of DOCUMENT_TOOLS) registerToolService(t.slug, 'documents');
}
