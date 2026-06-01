/**
 * The expectation matrix — one row per fixture. This is the heart of the
 * harness: it declares, per node type, what a *correct* brain reaction looks
 * like. The runner inserts the fixture, reads the actual footprint, and the
 * asserter compares the two against the rules here.
 *
 * Conservative by design for Phase 1: we hard-assert the invariants that hold
 * regardless of extractor config (a processed node MUST get a summary +
 * 768-dim embedding + tsv; a scanned PDF MUST skip `no_text_layer`), and mark
 * config-dependent layers (facts/graph on task/event/contact) `optional` so a
 * correct allow-list decision doesn't read as a failure. Phase 2 will derive
 * those from the live worker config and add update/delete sub-tests.
 */
import type { FixtureExpectation, FixtureExpectation as Exp } from './types';
import type { FixtureBuilder, FixtureUpdater } from './fixtures';
import {
  buildNote,
  buildPage,
  buildTodo,
  buildEvent,
  buildContact,
  buildSecret,
  buildTextFile,
  buildPdfText,
  buildPdfScanned,
  buildDocx,
  buildXlsx,
  buildCsv,
  buildJson,
  buildMd,
  buildPptx,
  buildOdt,
  buildEpub,
  buildRtf,
  buildImage,
  buildPhoto,
  buildSvg,
  buildXml,
  buildAudio,
  updateNoteFixture,
  updatePageFixture,
  updateTodoFixture,
  updateEventFixture,
  updateContactFixture,
  updateSecretFixture,
  updateTextFileFixture,
} from './fixtures';

export type FixtureSpec = {
  /** Stable key — also the grid row id and the `only` filter token. */
  key: string;
  /** Human label for the grid. */
  label: string;
  /** The node type this fixture creates (for the grid's type column). */
  nodeType: string;
  /** Which pipeline this belongs to — Content for now; Dialog/Worker later. */
  pipeline: 'content' | 'file';
  build: FixtureBuilder;
  expect: FixtureExpectation;
  /** Optional edit that should re-trigger extraction — drives the update sub-test. */
  update?: FixtureUpdater;
};

/** A fully-processed content node: summary + 768 embedding + tsv + facts + graph. */
const FULL: Exp = {
  trace: { status: 'success' },
  summary: 'present',
  embedding: 'present',
  tsv: 'present',
  facts: 'present',
  graph: 'present',
};

/** Indexed but facts/graph are config- or content-dependent (don't fail on absence). */
const INDEXED_SOFT: Exp = {
  trace: { status: 'success' },
  summary: 'present',
  embedding: 'present',
  tsv: 'present',
  facts: 'optional',
  graph: 'optional',
};

/** Optional-service tiers (Tika, vision): index IF the service is up, else the
 *  correct outcome is a `no_text_layer` skip. Either passes; the disposition
 *  pill shows which path actually ran. Phase 2 will gate this on the live
 *  service config to make it a hard assertion. */
const OPTIONAL_SERVICE: Exp = {
  trace: { status: 'either', skipDisposition: 'no_text_layer' },
  summary: 'optional',
  embedding: 'optional',
  tsv: 'optional',
  facts: 'optional',
  graph: 'optional',
};

/** No parser routes this type (svg/xml/audio): a skip is the correct outcome.
 *  Observational for now — accepts any terminal status, surfaces the
 *  disposition. Phase 2 will pin the exact expected disposition. */
const SKIP_EXPECTED: Exp = {
  trace: { status: 'either' },
  summary: 'optional',
  embedding: 'optional',
  tsv: 'optional',
  facts: 'optional',
  graph: 'optional',
};

export const SPECS: FixtureSpec[] = [
  { key: 'note', label: 'Note', nodeType: 'note', pipeline: 'content', build: buildNote, expect: FULL, update: updateNoteFixture },
  { key: 'page', label: 'Page', nodeType: 'page', pipeline: 'content', build: buildPage, expect: FULL, update: updatePageFixture },
  {
    key: 'todo',
    label: 'Todo / task',
    nodeType: 'task',
    pipeline: 'content',
    build: buildTodo,
    // task facts only land if the type is in the extractor's target_types.
    expect: { ...INDEXED_SOFT, trace: { status: 'either', skipDisposition: 'type_not_in_allowlist' } },
    update: updateTodoFixture,
  },
  {
    key: 'event',
    label: 'Event',
    nodeType: 'event',
    pipeline: 'content',
    build: buildEvent,
    expect: { ...INDEXED_SOFT, trace: { status: 'either', skipDisposition: 'type_not_in_allowlist' } },
    update: updateEventFixture,
  },
  {
    key: 'contact',
    label: 'Contact',
    nodeType: 'contact',
    pipeline: 'content',
    build: buildContact,
    expect: INDEXED_SOFT,
    update: updateContactFixture,
  },
  {
    key: 'secret',
    label: 'Secret (metadata-only)',
    nodeType: 'secret',
    pipeline: 'content',
    build: buildSecret,
    // The sealed body must never reach the LLM — only title+description+tags
    // are indexed. So: indexed, but facts/graph are not expected.
    expect: { trace: { status: 'success' }, summary: 'present', embedding: 'present', tsv: 'present', facts: 'optional', graph: 'optional' },
    update: updateSecretFixture,
  },
  // In-process parsers — must index regardless of external services.
  { key: 'file_text', label: 'File · text', nodeType: 'file', pipeline: 'file', build: buildTextFile, expect: INDEXED_SOFT, update: updateTextFileFixture },
  { key: 'file_md', label: 'File · Markdown', nodeType: 'file', pipeline: 'file', build: buildMd, expect: INDEXED_SOFT },
  { key: 'file_csv', label: 'File · CSV', nodeType: 'file', pipeline: 'file', build: buildCsv, expect: INDEXED_SOFT },
  { key: 'file_json', label: 'File · JSON', nodeType: 'file', pipeline: 'file', build: buildJson, expect: INDEXED_SOFT },
  { key: 'file_pdf_text', label: 'File · PDF (text)', nodeType: 'file', pipeline: 'file', build: buildPdfText, expect: INDEXED_SOFT },
  { key: 'file_docx', label: 'File · DOCX', nodeType: 'file', pipeline: 'file', build: buildDocx, expect: INDEXED_SOFT },
  { key: 'file_xlsx', label: 'File · XLSX', nodeType: 'file', pipeline: 'file', build: buildXlsx, expect: INDEXED_SOFT },
  // PDF with no text layer — pdf-parse yields nothing; correct outcome is a skip.
  { key: 'file_pdf_scanned', label: 'File · PDF (scanned)', nodeType: 'file', pipeline: 'file', build: buildPdfScanned, expect: OPTIONAL_SERVICE },
  // Tika fallback — indexes only if the Tika service is up.
  { key: 'file_pptx', label: 'File · PPTX (Tika)', nodeType: 'file', pipeline: 'file', build: buildPptx, expect: OPTIONAL_SERVICE },
  { key: 'file_odt', label: 'File · ODT (Tika)', nodeType: 'file', pipeline: 'file', build: buildOdt, expect: OPTIONAL_SERVICE },
  { key: 'file_epub', label: 'File · EPUB (Tika)', nodeType: 'file', pipeline: 'file', build: buildEpub, expect: OPTIONAL_SERVICE },
  { key: 'file_rtf', label: 'File · RTF (Tika)', nodeType: 'file', pipeline: 'file', build: buildRtf, expect: OPTIONAL_SERVICE },
  // Vision path — indexes only if the vision worker is wired.
  { key: 'file_image', label: 'File · image (PNG)', nodeType: 'file', pipeline: 'file', build: buildImage, expect: OPTIONAL_SERVICE },
  { key: 'file_photo', label: 'File · photo (JPG)', nodeType: 'file', pipeline: 'file', build: buildPhoto, expect: OPTIONAL_SERVICE },
  // No parser routes these — a skip is the correct outcome.
  { key: 'file_svg', label: 'File · SVG', nodeType: 'file', pipeline: 'file', build: buildSvg, expect: SKIP_EXPECTED },
  { key: 'file_xml', label: 'File · XML', nodeType: 'file', pipeline: 'file', build: buildXml, expect: SKIP_EXPECTED },
  { key: 'file_audio', label: 'File · audio (MP3)', nodeType: 'file', pipeline: 'file', build: buildAudio, expect: SKIP_EXPECTED },
];

export const SPEC_BY_KEY = new Map(SPECS.map((s) => [s.key, s]));
