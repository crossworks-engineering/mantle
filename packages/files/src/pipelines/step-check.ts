/**
 * The one check of a step's result (docs/pipelines.md, "The runner"). The
 * parser job runs it before it writes `out.json`, and the brain's client
 * runs it again when it reads the answer, as it checks the sheets of a grid.
 * A result that fails it is a `failed` job. This is one check: do not add a
 * second one beside it. It holds every field a result carries, so nothing of
 * the wrong type reaches the loop or the SQLite writer as a throw that is no
 * parser failure.
 */
import {
  FILE_TABS_WRITE,
  PIPELINE_CALLS_MAX,
  PIPELINE_KIND_MAX_CHARS,
  PIPELINE_STATE_MAX_BYTES,
  type PipelineStepResult,
} from './contract';

const STATUSES: ReadonlySet<string> = new Set(['ok', 'not_mine', 'unsure', 'failed']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Absent, or of the type the field is. */
const isStr = (v: unknown) => v === undefined || typeof v === 'string';
const isStrs = (v: unknown) =>
  v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
const isNum = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
/** A cell of ParsedSheet: text, a finite number, a checkbox or empty. */
const isCell = (v: unknown) =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v));

/** A tab in the form of ParsedSheet (../sheet-to-grid.ts). */
function isSheet(v: unknown): boolean {
  return (
    isObject(v) &&
    typeof v.name === 'string' &&
    Array.isArray(v.columns) &&
    v.columns.every(
      (c) => isObject(c) && typeof c.name === 'string' && typeof c.type === 'string',
    ) &&
    Array.isArray(v.rows) &&
    v.rows.every((r) => Array.isArray(r) && r.every(isCell))
  );
}

/** A picture a write names: a file name and its type, and a caption. */
const isPicture = (p: unknown) =>
  isObject(p) && typeof p.file === 'string' && typeof p.mime === 'string' && isStr(p.caption);

/** The input of the write call (FileTabsWriteInput), field by field. */
function writeProblem(input: unknown): string | null {
  if (!isObject(input) || !Array.isArray(input.tabs) || !input.tabs.every(isSheet)) {
    return 'the write call has no tabs in the form of sheets';
  }
  const ok =
    isStr(input.description) &&
    isStrs(input.ftsSkipColumns) &&
    isStr(input.sourceSha256) &&
    isStr(input.text) &&
    (input.pictures === undefined ||
      (Array.isArray(input.pictures) && input.pictures.every(isPicture)));
  return ok ? null : 'a field of the write call is not of its type';
}

function callProblem(c: unknown): string | null {
  if (!isObject(c)) return 'a call is not an object';
  if (c.call === 'worker')
    return typeof c.worker === 'string' && isStr(c.question) ? null : 'a worker call has no worker';
  if (c.call !== 'tool' || typeof c.tool !== 'string')
    return 'a call is neither a worker nor a tool';
  return c.tool === FILE_TABS_WRITE ? writeProblem(c.input) : null;
}

/** The result, or why it is refused. */
export function checkStepResult(
  raw: unknown,
): { ok: true; result: PipelineStepResult } | { ok: false; why: string } {
  if (!isObject(raw) || typeof raw.status !== 'string' || !STATUSES.has(raw.status)) {
    return { ok: false, why: 'the status is not one of ok, not_mine, unsure, failed' };
  }
  if (raw.calls !== undefined) {
    if (!Array.isArray(raw.calls)) return { ok: false, why: 'the calls are not a list' };
    if (raw.calls.length > PIPELINE_CALLS_MAX) {
      return { ok: false, why: `more than ${PIPELINE_CALLS_MAX} calls` };
    }
    for (const c of raw.calls) {
      const why = callProblem(c);
      if (why) return { ok: false, why };
    }
  }
  if (raw.state !== undefined) {
    const json = JSON.stringify(raw.state);
    if (json !== undefined && Buffer.byteLength(json, 'utf8') > PIPELINE_STATE_MAX_BYTES) {
      return { ok: false, why: `the state is over ${PIPELINE_STATE_MAX_BYTES / 1024} KB` };
    }
  }
  if (
    raw.kind !== undefined &&
    (typeof raw.kind !== 'string' || raw.kind.length > PIPELINE_KIND_MAX_CHARS)
  ) {
    return {
      ok: false,
      why: `the kind is not a text of ${PIPELINE_KIND_MAX_CHARS} characters at most`,
    };
  }
  const counts = raw.counts;
  const fields =
    isStrs(raw.warnings) &&
    isNum(raw.confidence) &&
    isStr(raw.answer) &&
    (counts === undefined ||
      (isObject(counts) && Object.values(counts).every((n) => isNum(n) && n !== undefined)));
  if (!fields) return { ok: false, why: 'a field of the result is not of its type' };
  return { ok: true, result: raw as PipelineStepResult };
}
