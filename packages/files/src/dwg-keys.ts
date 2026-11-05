/**
 * The file row's data keys that hold a drawing's image-check answers. Their own
 * module, with no imports, as the privacy strip (indexing.ts) needs them and not
 * the parser that `./dwg` brings.
 */

/** File node data key: the image check's answers (circuit_verify), sealed
 *  under the file's id (packages/tools/src/circuit-trace/checks-store.ts). */
export const DWG_ANSWERS_KEY = 'drawingChecks';
/** File node data key: the circuit_verify calls claimed on the drawing. */
export const DWG_VERIFY_RUNS_KEY = 'dwgVerifyRuns';
