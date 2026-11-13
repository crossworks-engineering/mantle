/**
 * The options of a pipeline: pure, no I/O (docs/pipelines-options.md).
 *
 * A manifest declares its options (PipelineManifest.options). A box keeps
 * only what an Admin changed, in the table pipeline_state
 * (packages/content/src/pipeline-state.ts). Three functions, one job each:
 *
 *  - checkOptions: the one check of a write. Nothing goes into the table
 *    that did not pass it.
 *  - effectiveOptions: the values in force on a read. The defaults, with
 *    each stored value that still passes its spec. It never throws, so a
 *    read at upload cannot fail on an old row.
 *  - optionsHash: '' for all defaults, so a box that never set an option
 *    writes the phase 1 stamp, key for key.
 *
 * Options are numbers, yes or no, and word lists. There is no pattern type,
 * by choice (contract.ts, PipelineOptionSpec).
 */
import { createHash } from 'node:crypto';
import type { PipelineManifest, PipelineOptionSpec } from './contract';

/** The form of an option's name. */
export const OPTION_NAME = /^[a-z0-9_]{1,40}$/;
/** The most words a `words` option may allow, and the longest word. */
export const OPTION_WORDS_MAX_ITEMS = 200;
export const OPTION_WORD_MAX_CHARS = 16;

/** One word of a `words` option, after it is made upper case. */
const WORD = /^[A-Z0-9][A-Z0-9._/-]*$/;

type One = { ok: true; value: unknown } | { ok: false; error: string };

/** One value against its spec: the value as it is kept, or the sentence
 *  that refuses it. Words are made upper case, and doubles go. */
function checkOne(name: string, spec: PipelineOptionSpec, value: unknown): One {
  switch (spec.type) {
    case 'number':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < spec.min ||
        value > spec.max
      ) {
        return {
          ok: false,
          error: `Option "${name}" must be a number from ${spec.min} to ${spec.max}.`,
        };
      }
      return { ok: true, value };
    case 'bool':
      if (typeof value !== 'boolean')
        return { ok: false, error: `Option "${name}" must be yes or no.` };
      return { ok: true, value };
    case 'words': {
      if (!Array.isArray(value))
        return { ok: false, error: `Option "${name}" must be a list of words.` };
      const out: string[] = [];
      for (const w of value) {
        const word = typeof w === 'string' ? w.trim().toUpperCase() : '';
        if (word.length < 1 || word.length > spec.maxChars || !WORD.test(word)) {
          return {
            ok: false,
            error:
              `Option "${name}": ${JSON.stringify(typeof w === 'string' ? w : String(w)).slice(0, 40)} is not a word. ` +
              `A word is 1 to ${spec.maxChars} of A-Z, 0-9, ".", "_", "/" and "-", and starts with a letter or a digit.`,
          };
        }
        if (!out.includes(word)) out.push(word);
      }
      if (out.length > spec.maxItems) {
        return { ok: false, error: `Option "${name}" holds at most ${spec.maxItems} words.` };
      }
      return { ok: true, value: out };
    }
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The one check of a write: each named option is declared and its value
 * passes its spec. Gives the values as they are kept (only the names that
 * were given), or the first refusal as a plain sentence.
 */
export function checkOptions(
  manifest: Pick<PipelineManifest, 'name' | 'options'>,
  input: unknown,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPlainObject(input))
    return { ok: false, error: 'Options must be a set of names and values.' };
  const specs = manifest.options ?? {};
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    const spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
    if (!spec)
      return { ok: false, error: `${manifest.name} has no option "${name.slice(0, 40)}".` };
    const one = checkOne(name, spec, value);
    if (!one.ok) return one;
    values[name] = one.value;
  }
  return { ok: true, values };
}

/**
 * The values in force: every declared option, its stored value when that
 * still passes its spec, else its default. A stored value of a name the
 * manifest no longer declares is left out. Never throws.
 */
export function effectiveOptions(
  manifest: Pick<PipelineManifest, 'options'>,
  stored: unknown,
): Record<string, unknown> {
  const from = isPlainObject(stored) ? stored : {};
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(manifest.options ?? {})) {
    const one = Object.hasOwn(from, name) ? checkOne(name, spec, from[name]) : null;
    out[name] = one?.ok ? one.value : spec.type === 'words' ? [...spec.default] : spec.default;
  }
  return out;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((x, i) => x === b[i])
    : a === b;

/**
 * The hash of the options in force: '' when every declared option has its
 * default, else the first 8 hex of the sha256 of the values as JSON with
 * sorted keys. A name the manifest does not declare is not hashed.
 */
export function optionsHash(
  manifest: Pick<PipelineManifest, 'options'>,
  values: Readonly<Record<string, unknown>>,
): string {
  const specs = manifest.options ?? {};
  const names = Object.keys(specs).sort();
  const of = (n: string) => (Object.hasOwn(values, n) ? values[n] : specs[n]!.default);
  if (names.every((n) => sameValue(of(n), specs[n]!.default))) return '';
  const sorted = Object.fromEntries(names.map((n) => [n, of(n)]));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 8);
}
