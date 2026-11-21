/**
 * The kit, version 1 (PIPELINE_KIT, ./contract.ts): the files of
 * packages/files/src that a packaged step may import, beside its own folder
 * and the contract (docs/pipelines.md, "The kit"). A file that two packages
 * need, or a package and the core, is kit and stays where it is. A file that
 * only one reader uses moves into that package's folder.
 *
 * kit.test.ts reads the import lines of every file under ./pkg/ and fails on
 * one that is not on this list. That is the one check. A bare package name
 * (`node:fs`, an npm package) is not the repo and is not checked; an
 * `@mantle/` name is the repo and is refused: a step imports the kit by its
 * relative path.
 *
 * The native helpers (the CAD tier, OpenCV, the PDF pictures) are kit too,
 * but a step reaches them through the job handle (StepJob), never by import.
 */
export const PIPELINE_KIT_FILES: readonly string[] = [
  // The sheet engine.
  'sheet-read.ts',
  'sheet-grid.ts',
  'sheet-to-grid.ts',
  'legacy-sheet.ts',
  // The PDF page reader.
  'pdf-open.ts',
  'pdf-primitives.ts',
  'pdf-drawing.ts',
  'pdf-drawing-score.ts',
  // The PDF kinds, rows, sheets and sketch read: the core reads the File
  // tab and the decider's state with them, the two PDF packages build with
  // them.
  'pdf-kind.ts',
  'pdf-rows.ts',
  'pdf-drawing-sheets.ts',
  'pdf-sketch.ts',
  // The page types of the router's part 2: the router's step builds the
  // page ask with it, the core checks it and keeps the answers with it.
  'pdf-page-kinds.ts',
  // The tag grammar.
  'pdf-tags.ts',
  // The shapes, and the contract.
  'pipelines/shapes.ts',
  'pipelines/contract.ts',
  // The plan check, and the CAD sniffs.
  'mspdi-sniff.ts',
  'cad-sniff.ts',
  // Limits and the zip guard.
  'read-limit.ts',
  'zip-guard.ts',
  'limits.ts',
  // A read in part (docs/files.md, "Read in part"): the shape of a cut and
  // the sink a step says it in (the CAD and DWF packages).
  'read-cut.ts',
  'read-cut-sink.ts',
];
