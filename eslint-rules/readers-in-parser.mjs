/**
 * readers-in-parser (docs/parser.md): an untrusted file is opened only in the
 * parser service. The modules that read a document's bytes (pdfjs, mammoth,
 * anydoc, our OOXML, Visio, markup and sheet readers, the image decoders)
 * live in packages/files behind `@mantle/files/readers/*`, and only the
 * parser (server/parser) imports them. Everything in api/web asks through
 * the one parser client (packages/files/src/parser-client.ts).
 *
 * Flagged, outside server/parser, the reader modules themselves and tests:
 *
 *  - an import (static, dynamic or re-export) of `@mantle/files/readers/...`;
 *  - inside packages/files, a relative import of a reader module (READERS);
 *  - an import of a parsing library (PARSING_LIBRARIES) anywhere.
 *
 * Not flagged: exceljs, jszip and saxes, which the brain also uses to WRITE
 * (workbook exports, app packages) and to sanitize SVG it produced; the
 * readers that use them to read are in READERS.
 *
 * eslint-rules/readers-in-parser.test.ts runs the same check over the tree.
 */
import { repoPathOf } from './arch-counts.mjs';

/** The reader modules of packages/files/src, by file name without `.ts`. */
export const READERS = Object.freeze([
  'anydoc',
  'docx',
  'dwf',
  'embedded-images-read',
  'image-read',
  'legacy-sheet',
  'markup',
  'mspdi',
  'ooxml-media',
  'pdf',
  'pdf-open',
  'pdf-password',
  'pptx',
  'rasterize',
  'read-document',
  'read-limit',
  'sheet-grid',
  'sheet-read',
  'vsdx',
  'xlsx',
  'xml-scan',
  'zip-guard',
]);

/** Libraries that parse untrusted documents or images. */
export const PARSING_LIBRARIES = Object.freeze([
  'pdfjs-dist',
  'pdf-parse',
  'mammoth',
  'pdf-to-png-converter',
  'heic-convert',
  '@firecrawl/anydoc',
]);

const FILES_SRC = 'packages/files/src/';

/** Whether `path` may import readers: the parser, a reader, a test. */
export function mayRead(path) {
  if (!path) return true;
  if (path.startsWith('server/parser/')) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /\.test-helper\.ts$/.test(path)) return true;
  if (path.startsWith(FILES_SRC)) {
    const name = path.slice(FILES_SRC.length).replace(/\.ts$/, '');
    return READERS.includes(name);
  }
  return false;
}

/** Why importing `source` from the file at `path` is a reader import, or
 *  null when it is not one. */
export function readerImport(source, path) {
  if (typeof source !== 'string') return null;
  if (source.startsWith('@mantle/files/readers/')) return `${source} is a reader`;
  if (PARSING_LIBRARIES.some((lib) => source === lib || source.startsWith(`${lib}/`))) {
    return `${source} parses untrusted bytes`;
  }
  if (path?.startsWith(FILES_SRC) && source.startsWith('./')) {
    const name = source.slice(2).replace(/\.(ts|js)$/, '');
    if (READERS.includes(name)) return `./${name} is a reader`;
  }
  return null;
}

/** Every reader import in `text` (a module's source), for the tree test.
 *  A type-only import or re-export (`import type`, `export type`) loads
 *  nothing and is left out. */
export function readerImportsIn(text, path) {
  const out = [];
  const re =
    /(?:\b(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?|\bimport\s*\(\s*)(['"])([^'"]+)\3/g;
  for (const m of text.matchAll(re)) {
    if (m[2]) continue;
    const why = readerImport(m[4], path);
    if (why) out.push(why);
  }
  return out;
}

const MESSAGE =
  'An untrusted file is read only in the parser service ({{why}}). Ask the parser client instead (parseDocumentBytes, extractEmbeddedImages, parseSpreadsheetToGrid, parserText, parserRasterizePdf... in @mantle/files); a new reader goes under @mantle/files/readers and a parser route (docs/parser.md).';

export const readersInParser = {
  meta: {
    type: 'problem',
    docs: { description: 'Untrusted files are read only in the parser service (docs/parser.md).' },
    messages: { reader: MESSAGE },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (mayRead(path)) return {};
    const check = (node, source) => {
      // A type-only import or re-export loads nothing.
      if (node.importKind === 'type' || node.exportKind === 'type') return;
      const why = readerImport(source, path);
      if (why) context.report({ node, messageId: 'reader', data: { why } });
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value);
      },
    };
  },
};

export default {
  rules: { 'readers-in-parser': readersInParser },
};
