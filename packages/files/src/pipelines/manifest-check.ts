/**
 * The one check of a manifest, for a built-in and for an own pipeline
 * (docs/pipelines.md, "The registry"). builtin.test.ts runs it on every
 * built-in, so both pass the same rules. Pure: it reads the manifest only.
 *
 * The common rules: the id form (the pattern of pipeline_set), a name, a
 * plain description, an `x.y.z` version, this contract's api, a kit no
 * newer than this one, 1 to 10 lower-case extensions, option specs the
 * option check can use, and a time of 1 to 240,000 ms.
 *
 * The rules of an own pipeline (`source: 'own'`) in phase 3: a reader only
 * (no router, no claimed kinds, no `after`), at upload, on Bun or Python,
 * with no AI worker, no tool but the write, no promised shape and no key
 * `draft` (the word only pipeline_test gives its own run); its
 * entry is a plain path inside the package (badNewPath), a .ts or .js file
 * on Bun and a .py file on Python. An own
 * reader runs with no `ask` (readSheets), so a worker could never answer
 * it; the refusal keeps the screen honest and adds no check at run time.
 *
 * `needs.memoryMb`, `needs.weight` (beyond its two words) and `match.magic`
 * are taken and do nothing, as for the built-ins.
 */
import { badNewPath } from '@mantle/std';
import {
  FILE_TABS_WRITE,
  PIPELINE_API,
  PIPELINE_DESCRIPTION_MAX,
  PIPELINE_KIT,
  PIPELINE_WINDOW_MB_MAX,
  PIPELINE_WINDOW_PAGES_MAX,
  type PipelineManifest,
  type PipelineSource,
} from './contract';
import {
  OPTION_NAME,
  OPTION_WORD_MAX_CHARS,
  OPTION_WORDS_MAX_ITEMS,
  checkOptions,
} from './options';

/** The form of a pipeline's id: the pattern of pipeline_set. */
export const PIPELINE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The longest time a step may take: the parser's cap (parserJobTimeoutMs). */
export const PIPELINE_TIME_MAX_MS = 240_000;

const SEMVER = /^\d+\.\d+\.\d+$/;
const EXT = /^[a-z0-9]{1,10}$/;
const EXTS_MAX = 10;
const NAME_MAX = 80;
/** One line of plain text: no markup, no long dashes. */
const NOT_PLAIN = /[\n<>`*#]|—|–/;

export type ManifestCheck = { ok: true; manifest: PipelineManifest } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first rule a manifest breaks, as a plain sentence, or null. */
function firstBreak(m: Record<string, unknown>, source: PipelineSource): string | null {
  const id = typeof m.id === 'string' ? m.id : '';
  if (!PIPELINE_ID.test(id)) {
    return 'The id must be 1 to 40 of a-z, 0-9 and "-", and start with a letter or a digit.';
  }
  if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > NAME_MAX) {
    return `The name must be 1 to ${NAME_MAX} characters.`;
  }
  const d = m.description;
  if (typeof d !== 'string' || d.trim() === '' || d.length > PIPELINE_DESCRIPTION_MAX) {
    return `The description must be 1 to ${PIPELINE_DESCRIPTION_MAX} characters.`;
  }
  if (NOT_PLAIN.test(d)) return 'The description must be one line of plain text.';
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
    return 'The version must be three numbers, such as 1.0.0.';
  }
  if (m.api !== PIPELINE_API) return `The api must be ${PIPELINE_API}, this contract's.`;
  if (m.kit !== undefined && !(Number.isInteger(m.kit) && (m.kit as number) <= PIPELINE_KIT)) {
    return `The kit must be a whole number no higher than ${PIPELINE_KIT}.`;
  }
  if (m.runtime !== 'core' && m.runtime !== 'bun' && m.runtime !== 'python') {
    return 'The runtime must be bun or python.';
  }
  if (m.runtime !== 'core' && (typeof m.entry !== 'string' || m.entry === '')) {
    return 'The entry must name the file of the step.';
  }
  if (m.start !== 'upload' && m.start !== 'demand') return 'The start must be upload or demand.';
  const match = isObject(m.match) ? m.match : {};
  const ext = match.ext;
  if (
    !Array.isArray(ext) ||
    ext.length < 1 ||
    ext.length > EXTS_MAX ||
    !ext.every((e) => typeof e === 'string' && EXT.test(e))
  ) {
    return `match.ext must be 1 to ${EXTS_MAX} extensions, each 1 to 10 of a-z and 0-9.`;
  }
  if (!isObject(m.produces)) return 'produces must be a set of fields.';
  const needs = isObject(m.needs) ? m.needs : null;
  if (!needs || (needs.weight !== 'light' && needs.weight !== 'heavy')) {
    return 'needs.weight must be light or heavy.';
  }
  const t = needs.timeMs;
  if (
    t !== undefined &&
    !(Number.isInteger(t) && (t as number) >= 1 && (t as number) <= PIPELINE_TIME_MAX_MS)
  ) {
    return `needs.timeMs must be a whole number from 1 to ${PIPELINE_TIME_MAX_MS}.`;
  }
  const windowBroken = windowBreak(needs.window, match.ext as string[]);
  if (windowBroken) return windowBroken;
  const options = m.options === undefined ? {} : m.options;
  if (!isObject(options)) return 'options must be a set of names and specs.';
  for (const [name, spec] of Object.entries(options)) {
    const broken = specBreak(m.name, name, spec);
    if (broken) return broken;
  }
  if (source === 'own') return ownBreak(m, match, needs);
  return null;
}

/** What is wrong with `needs.window`, or null: a PDF reader's only, of
 *  1 to PIPELINE_WINDOW_PAGES_MAX pages and 1 to PIPELINE_WINDOW_MB_MAX MB. */
function windowBreak(window: unknown, ext: readonly string[]): string | null {
  if (window === undefined) return null;
  const whole = (v: unknown, max: number) =>
    Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
  if (
    !isObject(window) ||
    !whole(window.pages, PIPELINE_WINDOW_PAGES_MAX) ||
    !whole(window.mb, PIPELINE_WINDOW_MB_MAX)
  ) {
    return `needs.window must be { pages: 1 to ${PIPELINE_WINDOW_PAGES_MAX}, mb: 1 to ${PIPELINE_WINDOW_MB_MAX} }.`;
  }
  if (ext.length !== 1 || ext[0] !== 'pdf') return 'needs.window is for a pipeline of .pdf only.';
  return null;
}

/** What is wrong with one option spec, or null. */
function specBreak(pipeline: string, name: string, spec: unknown): string | null {
  const bad = `Option "${name.slice(0, 40)}" has a spec the option check cannot use.`;
  if (!OPTION_NAME.test(name)) {
    return `Option "${name.slice(0, 40)}": a name is 1 to 40 of a-z, 0-9 and "_", and starts with a letter.`;
  }
  if (!isObject(spec) || typeof spec.label !== 'string' || spec.label === '') return bad;
  if (spec.type === 'number') {
    const { min, max } = spec;
    if (typeof min !== 'number' || typeof max !== 'number' || !(min <= max)) return bad;
  } else if (spec.type === 'words') {
    const { maxItems, maxChars } = spec;
    if (!Number.isInteger(maxItems) || (maxItems as number) < 1) return bad;
    if ((maxItems as number) > OPTION_WORDS_MAX_ITEMS) return bad;
    if (!Number.isInteger(maxChars) || (maxChars as number) < 1) return bad;
    if ((maxChars as number) > OPTION_WORD_MAX_CHARS) return bad;
  } else if (spec.type !== 'bool') {
    return bad;
  }
  // The default must be a value its own check keeps as it is.
  const manifest = { name: pipeline, options: { [name]: spec } } as Pick<
    PipelineManifest,
    'name' | 'options'
  >;
  const back = checkOptions(manifest, { [name]: spec.default });
  if (!back.ok || JSON.stringify(back.values[name]) !== JSON.stringify(spec.default)) {
    return `Option "${name}": its default does not pass its own spec.`;
  }
  return null;
}

/** What an own pipeline may not have in phase 3, or null. */
function ownBreak(
  m: Record<string, unknown>,
  match: Record<string, unknown>,
  needs: Record<string, unknown>,
): string | null {
  if (m.router !== undefined || match.kind !== undefined || match.after !== undefined) {
    return 'An own pipeline is a Reader: it may not be a router, claim kinds or read another database.';
  }
  if (m.start !== 'upload') return 'An own pipeline runs at upload: start must be upload.';
  // `draft` is the word pipeline_test gives its own run; a manifest that
  // held it would send every upload to a draft folder.
  if (m.draft !== undefined) {
    return 'An own manifest has no key draft: test a draft with pipeline_test and files.';
  }
  if (m.runtime !== 'bun' && m.runtime !== 'python') return 'The runtime must be bun or python.';
  // The entry is a plain path inside the package (the one path rule); the
  // parser builds its own path from the checked id and version only.
  const entry = m.entry as string;
  const badEntry = badNewPath(entry, 'the package');
  if (badEntry) return `The entry: ${badEntry}.`;
  const wants = m.runtime === 'bun' ? /\.(ts|js)$/ : /\.py$/;
  if (!wants.test(entry)) {
    return m.runtime === 'bun'
      ? 'The entry of a bun pipeline is a .ts or .js file, such as step.ts.'
      : 'The entry of a python pipeline is a .py file, such as step.py.';
  }
  if (needs.workers !== undefined)
    return 'An own pipeline asks no AI worker: leave out needs.workers.';
  const tools = needs.tools;
  if (
    tools !== undefined &&
    !(
      Array.isArray(tools) &&
      (tools.length === 0 || (tools.length === 1 && tools[0] === FILE_TABS_WRITE))
    )
  ) {
    return `An own pipeline calls no tool but ${FILE_TABS_WRITE}.`;
  }
  const produces = m.produces as Record<string, unknown>;
  if (produces.shapes !== undefined)
    return 'An own pipeline promises no shape: leave out produces.shapes.';
  return null;
}

/**
 * Check a manifest: the manifest as it is, or the first rule it breaks as
 * a plain sentence. `source`: 'own' adds the rules of an own pipeline.
 */
export function checkManifest(manifest: unknown, source: PipelineSource): ManifestCheck {
  if (!isObject(manifest)) return { ok: false, error: 'The manifest must be a set of fields.' };
  const error = firstBreak(manifest, source);
  return error ? { ok: false, error } : { ok: true, manifest: manifest as PipelineManifest };
}
