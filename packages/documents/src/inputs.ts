import { InputError } from '@mantle/std';
import { readFileById } from '@mantle/files';
import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { printOrigin } from './print-origin';
import { buildRenderToken, RENDER_COOKIE_NAME } from './render-token';
import type { RouteDef } from './routes';

/**
 * Inputs are Mantle refs, never paths or raw parts: file ids the caller may
 * read (readFileById, in the caller's scope), a node id printed through
 * /print with a render cookie minted for the caller, or inline html and
 * markdown. Each input is capped, and so is their sum.
 */
export type DocumentsInputs = {
  /** The main files: Office files, PDFs, or (html and markdown routes) the
   *  index.html / .md files. */
  file_ids?: string[];
  /** A page or a drawing of this brain (the url routes). */
  node_id?: string;
  /** Inline HTML: index.html of the html routes, or the wrapper of the
   *  markdown routes (it must contain `{{ toHTML "file.md" }}`). */
  html?: string;
  /** Inline markdown (the markdown routes): saved as file.md. */
  markdown?: string;
  /** Files beside index.html (images, CSS, fonts), by their own names. */
  asset_file_ids?: string[];
  /** A full HTML document for the page header or footer (the convert
   *  routes). `<span class="pageNumber">` and `totalPages` are filled in. */
  header_html?: string;
  footer_html?: string;
  watermark_file_id?: string;
  stamp_file_id?: string;
  facturx_file_id?: string;
  embed_file_ids?: string[];
};

/** Per input and in total (bytes); the inline texts are smaller. The
 *  inputs and the answer are buffered in this process for the length of
 *  the job (up to the engine's queue), several jobs at once
 *  (DOCUMENTS_MAX_IN_FLIGHT), so the total stays modest. */
export const DOCUMENTS_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const DOCUMENTS_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const DOCUMENTS_MAX_INLINE_BYTES = 4 * 1024 * 1024;
export const DOCUMENTS_MAX_FILES = 50;

/** The input types LibreOffice takes (Gotenberg 8.39 docs), by extension. */
export const LIBREOFFICE_EXTENSIONS: ReadonlySet<string> = new Set(
  '123 602 abw bib bmp cdr cgm cmx csv cwk dbf dif doc docm docx dot dotm dotx dxf emf eps epub fodg fodp fods fodt fopd gif htm html hwp jpeg jpg key ltx lwp mcw met mml mw numbers odd odg odm odp ods odt oth otg otp ots ott pages pbm pcd pct pcx pdb pdf pgm png pot potm potx ppm pps ppt pptm pptx psd psw pub pwp pxl ras rtf sda sdc sdd sdp sdw sgl slk smf stc std sti stw svg svm swf sxc sxd sxg sxi sxm sxw tga tif tiff txt uof uop uos vdx vor vsd vsdm vsdx wb2 wk1 wks wmf wpd wpg wps xbm xhtml xls xlsb xlsm xlsx xlt xltm xltx xlw xml xpm zabw'.split(
    ' ',
  ),
);

/** A resolved part: its name on the form and its bytes. */
export type Part = { field: string; filename: string; bytes: Buffer };

/** What a node print needs beyond the parts: the URL and the cookie. */
export type NodePrint = { url: string; kind: 'page' | 'draw'; cookieJson: string };

export type ResolvedInputs = {
  parts: Part[];
  node: NodePrint | null;
  /** The stem the output is named after when the caller names none. */
  stem: string;
  /** The node id the output is an export of, for the file's data. */
  exportOf: string | null;
};

/** Who the inputs are read for and printed as. */
export type DocumentsCaller = {
  ownerId: string;
  /** The login a render cookie is minted for (an Admin login opens the
   *  print surfaces); null when the caller is no login: a node print is
   *  then refused, the other inputs work. */
  actorLoginId: string | null;
  /** Whether that login is an Admin user, when the surface knows (the HTTP
   *  route does; a tool call does not): false refuses a node print up
   *  front, in the package's words, instead of the engine's 403. */
  admin?: boolean;
};

/** The reads the resolver makes, injectable for tests. */
export type InputDeps = {
  readFile: (
    ownerId: string,
    fileId: string,
  ) => Promise<{ filename: string; bytes: Buffer } | null>;
  nodeKind: (ownerId: string, nodeId: string) => Promise<'page' | 'draw' | 'other' | null>;
};

const DEFAULT_DEPS: InputDeps = {
  readFile: async (ownerId, fileId) => {
    const res = await readFileById({ ownerId, fileId });
    return res ? { filename: res.row.filename, bytes: res.bytes } : null;
  },
  nodeKind: async (ownerId, nodeId) => {
    const [row] = await db
      .select({ type: nodes.type })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
      .limit(1);
    if (!row) return null;
    return row.type === 'page' ? 'page' : row.type === 'draw' ? 'draw' : 'other';
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ids(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.length > DOCUMENTS_MAX_FILES) {
    throw new InputError(
      `${name}: at most ${DOCUMENTS_MAX_FILES} files in one call (got ${list.length})`,
    );
  }
  return list.map((x) => {
    if (typeof x !== 'string' || !UUID_RE.test(x)) {
      throw new InputError(
        `${name}: each entry must be a file id (uuid); find ids with file_list or search`,
      );
    }
    return x.toLowerCase();
  });
}

function text(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new InputError(`${name} must be a string`);
  if (Buffer.byteLength(v, 'utf8') > DOCUMENTS_MAX_INLINE_BYTES) {
    throw new InputError(
      `${name} is larger than ${DOCUMENTS_MAX_INLINE_BYTES / 1024 / 1024} MB; upload it as a file and pass its id in file_ids`,
    );
  }
  return v;
}

const ext = (filename: string): string => filename.toLowerCase().replace(/^.*\./, '');
const stemOf = (filename: string): string => filename.replace(/\.[^.]+$/, '') || 'document';

/** A caller's inputs, checked and read, as the parts of one form. */
export async function resolveInputs(
  route: RouteDef,
  raw: unknown,
  caller: DocumentsCaller,
  deps: InputDeps = DEFAULT_DEPS,
): Promise<ResolvedInputs> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new InputError('inputs must be an object (file_ids, node_id, html, markdown, ...)');
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const known = new Set([
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
  ]);
  for (const k of Object.keys(input)) {
    if (!known.has(k))
      throw new InputError(`inputs.${k} is not an input; the inputs are ${[...known].join(', ')}`);
  }
  const parts: Part[] = [];
  let total = 0;
  const take = async (field: string, filename: string, bytes: Buffer): Promise<void> => {
    if (bytes.length > DOCUMENTS_MAX_INPUT_BYTES) {
      throw new InputError(
        `${filename} is ${Math.round(bytes.length / 1024 / 1024)} MB; one input may be at most ${DOCUMENTS_MAX_INPUT_BYTES / 1024 / 1024} MB`,
      );
    }
    total += bytes.length;
    if (total > DOCUMENTS_MAX_TOTAL_BYTES) {
      throw new InputError(
        `the inputs together pass ${DOCUMENTS_MAX_TOTAL_BYTES / 1024 / 1024} MB; split the call`,
      );
    }
    if (parts.some((p) => p.field === field && p.filename === filename)) {
      throw new InputError(
        `two inputs are both named ${filename}; the engine keeps one flat directory, so names must differ`,
      );
    }
    parts.push({ field, filename, bytes });
  };
  const readFile = async (fileId: string, name: string) => {
    const file = await deps.readFile(caller.ownerId, fileId);
    if (!file)
      throw new InputError(
        `${name}: file ${fileId} was not found, or you may not read it; find it with file_list or search`,
      );
    return file;
  };

  let stem = 'document';
  let node: NodePrint | null = null;
  let exportOf: string | null = null;
  const fileIds = ids(input.file_ids, 'file_ids');
  const html = text(input.html, 'html');
  const markdown = text(input.markdown, 'markdown');

  switch (route.input) {
    case 'html': {
      if (markdown)
        throw new InputError(
          `markdown is not an input of ${route.key}; use chromium/convert/markdown`,
        );
      if (html && fileIds.length)
        throw new InputError('give html or one .html file in file_ids, not both');
      if (html) await take('files', 'index.html', Buffer.from(html, 'utf8'));
      else if (fileIds.length === 1) {
        const f = await readFile(fileIds[0]!, 'file_ids');
        if (!['html', 'htm', 'xhtml'].includes(ext(f.filename))) {
          throw new InputError(
            `file_ids: ${f.filename} is not an HTML file; the ${route.key} route takes html (inline) or one .html file`,
          );
        }
        stem = stemOf(f.filename);
        await take('files', 'index.html', f.bytes);
      } else throw new InputError(`${route.key} needs html (inline) or one .html file in file_ids`);
      break;
    }
    case 'markdown': {
      const mdIds = fileIds;
      if (!markdown && !mdIds.length)
        throw new InputError(`${route.key} needs markdown (inline) or .md files in file_ids`);
      const names: string[] = [];
      if (markdown) {
        await take('files', 'file.md', Buffer.from(markdown, 'utf8'));
        names.push('file.md');
      }
      for (const id of mdIds) {
        const f = await readFile(id, 'file_ids');
        if (!['md', 'markdown'].includes(ext(f.filename))) {
          throw new InputError(
            `file_ids: ${f.filename} is not a markdown file; the ${route.key} route takes .md files`,
          );
        }
        if (stem === 'document') stem = stemOf(f.filename);
        await take('files', f.filename, f.bytes);
        names.push(f.filename);
      }
      const wrapper =
        html ??
        `<!doctype html><html><head><meta charset="utf-8"><title>${stem}</title></head><body>${names
          .map((n) => `{{ toHTML "${n}" }}`)
          .join('\n')}</body></html>`;
      if (!/\{\{\s*toHTML\s+"[^"]+"\s*\}\}/.test(wrapper)) {
        throw new InputError(
          'html (the markdown wrapper) must place the markdown with {{ toHTML "file.md" }}',
        );
      }
      await take('files', 'index.html', Buffer.from(wrapper, 'utf8'));
      break;
    }
    case 'node': {
      const nodeId = typeof input.node_id === 'string' ? input.node_id.toLowerCase() : '';
      if (!UUID_RE.test(nodeId))
        throw new InputError(
          `${route.key} needs node_id: the id of a page or a drawing (page_list, draw_list, search)`,
        );
      if (html || markdown || fileIds.length)
        throw new InputError(
          `${route.key} takes node_id alone; html, markdown and file_ids are other routes' inputs`,
        );
      if (!caller.actorLoginId || caller.admin === false) {
        throw new InputError(
          'printing a page or a drawing needs a signed-in Admin user; pass html instead, or use export_node',
        );
      }
      const kind = await deps.nodeKind(caller.ownerId, nodeId);
      if (!kind) throw new InputError(`node_id: ${nodeId} was not found, or you may not read it`);
      if (kind === 'other')
        throw new InputError(
          `node_id: ${nodeId} is not a page or a drawing; a note or a table is exported with export_node`,
        );
      const token = buildRenderToken({
        ownerId: caller.ownerId,
        actorId: caller.actorLoginId,
        nodeId,
      });
      const origin = new URL(printOrigin());
      node = {
        kind,
        url: `${origin.origin}/print/${kind === 'page' ? 'pages' : 'draws'}/${nodeId}`,
        cookieJson: JSON.stringify([
          {
            name: RENDER_COOKIE_NAME,
            value: token,
            domain: origin.hostname,
            path: '/',
            httpOnly: true,
            secure: origin.protocol === 'https:',
            sameSite: 'Strict',
          },
        ]),
      };
      exportOf = nodeId;
      stem = kind;
      break;
    }
    case 'office':
    case 'pdf': {
      if (!fileIds.length)
        throw new InputError(
          `${route.key} needs file_ids: the ${route.input === 'pdf' ? 'PDF' : 'Office'} files to work on (file_list, search)`,
        );
      if (html || markdown)
        throw new InputError(`${route.key} takes files (file_ids), not html or markdown`);
      for (const id of fileIds) {
        const f = await readFile(id, 'file_ids');
        const e = ext(f.filename);
        if (route.input === 'pdf' && e !== 'pdf') {
          throw new InputError(
            `file_ids: ${f.filename} is not a PDF; ${route.key} takes .pdf files (convert an Office file first with libreoffice/convert)`,
          );
        }
        if (route.input === 'office' && !LIBREOFFICE_EXTENSIONS.has(e)) {
          throw new InputError(
            `file_ids: ${f.filename} (.${e}) is not a type LibreOffice reads; common ones are .docx .xlsx .pptx .odt .ods .odp .rtf .txt .csv .html .png .jpg`,
          );
        }
        if (stem === 'document') stem = stemOf(f.filename);
        await take('files', f.filename, f.bytes);
      }
      if (fileIds.length === 1) exportOf = fileIds[0]!;
      break;
    }
  }

  if (route.input === 'html' || route.input === 'markdown') {
    for (const id of ids(input.asset_file_ids, 'asset_file_ids')) {
      const f = await readFile(id, 'asset_file_ids');
      if (
        /^(index|header|footer)\.html?$/i.test(f.filename) ||
        /\.(md|markdown)$/i.test(f.filename)
      ) {
        throw new InputError(
          `asset_file_ids: ${f.filename} would replace the document, its header or its footer; assets are images, CSS and fonts`,
        );
      }
      await take('files', f.filename, f.bytes);
    }
  } else if (input.asset_file_ids !== undefined) {
    throw new InputError(
      `asset_file_ids belongs to the html and markdown routes, not ${route.key}`,
    );
  }

  const extras = new Set(route.extras);
  const refuse = (name: string) => {
    throw new InputError(`inputs.${name} is not an input of ${route.key}`);
  };
  const header = text(input.header_html, 'header_html');
  const footer = text(input.footer_html, 'footer_html');
  if (header) {
    if (!extras.has('header_html')) refuse('header_html');
    await take('files', 'header.html', Buffer.from(header, 'utf8'));
  }
  if (footer) {
    if (!extras.has('footer_html')) refuse('footer_html');
    await take('files', 'footer.html', Buffer.from(footer, 'utf8'));
  }
  for (const [name, field] of [
    ['watermark_file_id', 'watermark'],
    ['stamp_file_id', 'stamp'],
    ['facturx_file_id', 'facturxXml'],
  ] as const) {
    const [id] = ids(input[name], name);
    if (id === undefined) continue;
    if (!extras.has(name)) refuse(name);
    const f = await readFile(id, name);
    await take(field, f.filename, f.bytes);
  }
  const embedIds = ids(input.embed_file_ids, 'embed_file_ids');
  if (embedIds.length && !extras.has('embed_file_ids')) refuse('embed_file_ids');
  for (const id of embedIds) {
    const f = await readFile(id, 'embed_file_ids');
    await take('embeds', f.filename, f.bytes);
  }
  return { parts, node, stem, exportOf };
}
