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
import type { FixtureBuilder } from './fixtures';
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
  buildImage,
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

export const SPECS: FixtureSpec[] = [
  { key: 'note', label: 'Note', nodeType: 'note', pipeline: 'content', build: buildNote, expect: FULL },
  { key: 'page', label: 'Page', nodeType: 'page', pipeline: 'content', build: buildPage, expect: FULL },
  {
    key: 'todo',
    label: 'Todo / task',
    nodeType: 'task',
    pipeline: 'content',
    build: buildTodo,
    // task facts only land if the type is in the extractor's target_types.
    expect: { ...INDEXED_SOFT, trace: { status: 'either', skipDisposition: 'type_not_in_allowlist' } },
  },
  {
    key: 'event',
    label: 'Event',
    nodeType: 'event',
    pipeline: 'content',
    build: buildEvent,
    expect: { ...INDEXED_SOFT, trace: { status: 'either', skipDisposition: 'type_not_in_allowlist' } },
  },
  {
    key: 'contact',
    label: 'Contact',
    nodeType: 'contact',
    pipeline: 'content',
    build: buildContact,
    expect: INDEXED_SOFT,
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
  },
  { key: 'file_text', label: 'File · text', nodeType: 'file', pipeline: 'file', build: buildTextFile, expect: INDEXED_SOFT },
  { key: 'file_pdf_text', label: 'File · PDF (text)', nodeType: 'file', pipeline: 'file', build: buildPdfText, expect: INDEXED_SOFT },
  {
    key: 'file_pdf_scanned',
    label: 'File · PDF (scanned)',
    nodeType: 'file',
    pipeline: 'file',
    build: buildPdfScanned,
    // No text layer + no wired vision worker → the *correct* outcome is a skip.
    expect: { trace: { status: 'either', skipDisposition: 'no_text_layer' }, summary: 'optional', embedding: 'optional', tsv: 'optional', facts: 'optional', graph: 'optional' },
  },
  { key: 'file_docx', label: 'File · DOCX', nodeType: 'file', pipeline: 'file', build: buildDocx, expect: INDEXED_SOFT },
  {
    key: 'file_image',
    label: 'File · image',
    nodeType: 'file',
    pipeline: 'file',
    build: buildImage,
    // Image needs the vision worker; if unwired it correctly skips.
    expect: { trace: { status: 'either', skipDisposition: 'no_text_layer' }, summary: 'optional', embedding: 'optional', tsv: 'optional', facts: 'optional', graph: 'optional' },
  },
];

export const SPEC_BY_KEY = new Map(SPECS.map((s) => [s.key, s]));
