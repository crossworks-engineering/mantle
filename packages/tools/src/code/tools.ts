/**
 * The code tools: view, search and edit a source tree in place, the verbs of
 * the Anthropic text editor tool (view / str_replace / create / insert /
 * undo) and the MCP filesystem server's `edit_file` (`edits[]` + a dry-run
 * diff), so a model already knows their shape. Plain tools: the caller's
 * own model does the thinking; the brain makes no model call.
 *
 * One gateway over a `target`. Phase 1 has one kind, `app:<id>`: the app's
 * DRAFT source tree (else its published tree), written through the one draft
 * write (@mantle/content changeDraftSource) under the app's row lock, with
 * the revision check (`base_rev`) and an undo row on the app's history line
 * (`pre_code_edit`). A later kind (`sandbox:<name>`, a sandbox's /files)
 * is one more CodeStore.
 *
 * Access is the app tools': the reads ask what `app_get` asks, the writes
 * what `app_file_write` asks (the editDraft action, `ownerOnly` +
 * `loginTurns`, the author ceiling of `outside.appCode`). The gate's readers
 * of an argument read the target's app through code/target-ref.ts.
 */
import {
  AppDraftRevError,
  AppSourceLimitError,
  AppUndoEmptyError,
  AppUndoEntryError,
  AppUndoStaleError,
  CannotDeleteEntryError,
  changeDraftSource,
  getApp,
  MAX_APP_FILE_BYTES,
  sourceRev,
  undoCodeEdit,
  workingSource,
  type DraftChange,
} from '@mantle/content';
import type { AppSource } from '@mantle/db';
import { publicErrorText, UUID_RE } from '@mantle/std';
import { buildAndStageApp } from '../app-build-stage';
import { historyActor, ownerOnlyRefusal, withAuthorCeiling, WHO_HINT } from '../builtins-apps';
import { CS } from '../client-sourced-rule';
import { str } from '../coerce';
import { notFound } from '../errors';
import { actingLoginId } from '../surface';
import type { ToolPolicy } from '../tool-policy';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from '../types';
import { CODE_HISTORY_TOOLS } from './history';
import { appKit, type CodeKit } from './kit';
import { searchFiles } from './search';
import {
  appIdOfCodeTarget,
  APP_TARGET_PREFIX,
  badNewPath,
  codeFileKey,
  normCodePath,
} from './target-ref';
import {
  applyEdits,
  crlfOf,
  globMatcher,
  insertAfterLine,
  numberedView,
  splitLines,
  toCrlf,
  toLf,
  unifiedDiff,
  type TextEdit,
} from './text';

/** Lines one code_view returns at most; a longer range says where to go on. */
export const VIEW_MAX_LINES = 2000;
/** Edits one code_edit takes at most (the schema's maxItems). */
const EDITS_MAX = 50;
/** The longest search pattern. */
const PATTERN_MAX = 1000;
/** File diffs one undo returns at most; the rest are listed by path. */
const UNDO_DIFFS_MAX = 10;
/** Build errors a write with `build: true` returns at most. */
const BUILD_ERRORS_MAX = 10;

type Ctx = ToolHandlerContext;
type Fail = { ok: false; error: string };

// ─── Targets ─────────────────────────────────────────────────────────────────

/** A target's tree: its entry, files and revision. */
type CodeTree = { entry: string; files: Record<string, string>; rev: string };

type BuildReport =
  | { ok: true; bytes: number; warnings: number }
  | {
      ok: false;
      errors: { file: string | null; line: number | null; column: number | null; text: string }[];
      more: number;
      hint: string;
    };

type UndoResult = DraftChange & { undid: string; files: string[] };

/** What the tools need of a target kind. */
type CodeStore = {
  /** The target, as the tools write it back (`app:<id>`). */
  ref: string;
  /** What the target can use (language, entry, imports), read live. */
  kit(entry: string): CodeKit;
  read(): Promise<CodeTree | null>;
  change(
    fn: (tree: AppSource) => AppSource,
    opts: { baseRev: string | null; dryRun?: boolean; note: string },
  ): Promise<DraftChange | null>;
  undo(opts: {
    editId: string | null;
    path: string | null;
    baseRev: string | null;
  }): Promise<UndoResult | null>;
  build(): Promise<BuildReport | null>;
};

/** An app's draft tree (else its published one). */
function appStore(ctx: Ctx, id: string): CodeStore {
  return {
    ref: `${APP_TARGET_PREFIX}${id}`,
    kit: appKit,
    async read() {
      const app = await getApp(ctx.ownerId, id);
      if (!app) return null;
      const src = workingSource(app);
      return { entry: src.entry, files: src.files, rev: sourceRev(src) };
    },
    change: (fn, opts) =>
      changeDraftSource(ctx.ownerId, id, fn, {
        actor: historyActor(ctx),
        actorLoginId: actingLoginId(ctx.surface),
        note: opts.note,
        baseRev: opts.baseRev,
        dryRun: opts.dryRun,
      }),
    undo: (o) =>
      undoCodeEdit(ctx.ownerId, id, {
        actor: historyActor(ctx),
        actorLoginId: actingLoginId(ctx.surface),
        ...o,
      }),
    async build() {
      const res = await buildAndStageApp(ctx.ownerId, id);
      if (!res) return null;
      if (res.buildOk) return { ok: true, bytes: res.bytes, warnings: res.warnings.length };
      return {
        ok: false,
        errors: res.errors.slice(0, BUILD_ERRORS_MAX).map((e) => ({
          file: e.location?.file ?? null,
          line: e.location?.line ?? null,
          column: e.location?.column ?? null,
          text: e.text,
        })),
        more: Math.max(0, res.errors.length - BUILD_ERRORS_MAX),
        hint: 'The edit is saved in the draft; the build failed. Fix the files at these places and write again with build: true (code_view with no path lists the imports an app may use). The last good preview is untouched.',
      };
    },
  };
}

/** The store a `target` names, or the error that says how to name one. */
function openTarget(ctx: Ctx, raw: unknown): CodeStore | Fail {
  const id = appIdOfCodeTarget(raw);
  if (id) return appStore(ctx, id);
  const shown = typeof raw === 'string' && raw.trim() ? `'${raw.trim().slice(0, 80)}'` : 'it';
  return {
    ok: false,
    error: `target ${shown} names no source tree: write app:<id>, the app's id from app_list (code tools reach mini apps only for now)`,
  };
}

const missingApp = (store: CodeStore): Fail =>
  notFound('app', store.ref.slice(APP_TARGET_PREFIX.length), 'app_list');

/** The error for a path the tree does not hold, with a near name if one. */
function noFile(store: CodeStore, tree: CodeTree, path: string): Fail {
  const paths = Object.keys(tree.files).sort();
  const lower = path.toLowerCase();
  const base = lower.split('/').pop()!;
  const near =
    paths.find((p) => p.toLowerCase() === lower) ??
    paths.find((p) => p.toLowerCase().split('/').pop() === base);
  return {
    ok: false,
    error:
      `no file '${path}' in ${store.ref}` +
      (near ? `; did you mean '${near}'?` : '') +
      ` Its files: ${paths.slice(0, 20).join(', ')}${paths.length > 20 ? ', …' : ''} (code_view with no path lists them).`,
  };
}

/** A write's known refusals in their own words; anything else as it came. */
function writeError(err: unknown): Fail {
  if (
    err instanceof AppDraftRevError ||
    err instanceof AppSourceLimitError ||
    err instanceof AppUndoEmptyError ||
    err instanceof AppUndoEntryError ||
    err instanceof AppUndoStaleError
  ) {
    return { ok: false, error: err.message };
  }
  if (err instanceof CannotDeleteEntryError) {
    return {
      ok: false,
      error: 'the entry file cannot be removed: write its content instead (code_write)',
    };
  }
  return { ok: false, error: publicErrorText(err, 'code tools') };
}

/** Thrown inside a draft change: the call fails with its message and
 *  nothing is written. */
class ChangeRefused extends Error {}

/** The build after a write, when asked and something was written. */
async function maybeBuild(
  store: CodeStore,
  input: Record<string, unknown>,
  written: boolean,
): Promise<{ build?: BuildReport | { ok: false; error: string } | 'skipped' }> {
  if (input.build !== true) return {};
  if (!written) return { build: 'skipped' };
  try {
    const build = await store.build();
    return build ? { build } : {};
  } catch (err) {
    return { build: { ok: false, error: publicErrorText(err, 'code tools build') } };
  }
}

// ─── Policies and shared schema ──────────────────────────────────────────────

/** What `app_get` asks: a read of the app. */
const READ_POLICY: ToolPolicy = {
  matrix: { action: 'read', param: 'target', kinds: ['app'] },
  effect: 'read',
  spends: 'none',
  scope: 'any',
  keyArea: 'apps',
};

/** What `app_file_write` asks: a draft edit of the app. */
const WRITE_POLICY: ToolPolicy = {
  matrix: { action: 'editDraft', param: 'target', kinds: ['app'] },
  effect: 'write',
  spends: 'none',
  scope: 'any',
  outside: { appCode: true },
  itemArgs: [{ param: 'target', by: 'code-target' }],
  peerRisky: true,
  keyArea: 'apps',
  clientSourced: CS.onCodeTarget,
};

const TARGET_PROP = {
  type: 'string',
  description: "What to work on: app:<id>, the app's id from `app_list`, e.g. app:3f2a…",
};
const PATH_PROP = {
  type: 'string',
  description: "A file in the tree, e.g. 'App.tsx' or 'lib/fmt.ts'.",
};
const BASE_REV_PROP = {
  type: 'string',
  description:
    'The `rev` you last read (`code_view`, a write): a tree changed since is not written, the call fails with the current rev.',
};
const BUILD_PROP = {
  type: 'boolean',
  default: false,
  description: 'Run `app_build` after the write and return its errors (file, line, column).',
};

/** Run a draft change of one file (the change names the file's key in the
 *  tree it was given) that ends in that file's diff. */
async function writeFile(
  ctx: Ctx,
  input: Record<string, unknown>,
  fn: (tree: AppSource) => { tree: AppSource; path: string },
  opts: { note: string; dryRun?: boolean },
): Promise<ToolHandlerResult> {
  const store = openTarget(ctx, input.target);
  if ('ok' in store) return store;
  let path = normCodePath(input.path);
  try {
    const res = await store.change(
      (tree) => {
        const out = fn(tree);
        path = out.path;
        return out.tree;
      },
      {
        baseRev: str(input.base_rev).trim() || null,
        dryRun: opts.dryRun,
        note: opts.note,
      },
    );
    if (!res) return missingApp(store);
    const had = Object.hasOwn(res.before.files, path);
    const before = had ? res.before.files[path]! : '';
    const after = res.after.files[path] ?? '';
    ctx.step?.setOutput({ target: store.ref, path, rev: res.rev, written: res.written });
    const created = !had;
    return {
      ok: true,
      output: {
        target: store.ref,
        path,
        rev: res.rev,
        base_rev: res.beforeRev,
        edit_id: res.editId,
        ...(opts.dryRun ? { dry_run: true } : {}),
        written: res.written,
        ...(created
          ? { created: true, lines: splitLines(after).lines.length }
          : { diff: unifiedDiff(path, toLf(before), toLf(after)) }),
        ...(await maybeBuild(store, input, res.written)),
        hint: opts.dryRun
          ? 'Dry run: nothing was written. Send the same call without dry_run to apply it.'
          : res.written
            ? 'Saved in the DRAFT. Build with app_build (or pass build: true); the published app changes only at app_publish. code_undo with this edit_id takes it back.'
            : 'Nothing changed: the file already holds this text.',
      },
    };
  } catch (err) {
    if (err instanceof ChangeRefused) return { ok: false, error: err.message };
    return writeError(err);
  }
}

// ─── The tools ───────────────────────────────────────────────────────────────

const code_view: BuiltinToolDef = {
  slug: 'code_view',
  policy: READ_POLICY,
  name: 'View source code',
  description:
    "Read a mini app's source. With no `path`: the file tree (each file's size and line count), the tree's `rev`, and what this target can use (language, entry rule, allowed imports, each library's guide). With a `path`: that file as numbered lines, only `start`..`end` when given. Reads the DRAFT, else the published code. Pass `rev` back as `base_rev` on a write. To find text across files use `code_search`; for the manifest and build state use `app_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_PROP,
      path: PATH_PROP,
      start: { type: 'integer', minimum: 1, description: 'First line to show (1-based).' },
      end: { type: 'integer', minimum: 1, description: 'Last line to show (inclusive).' },
    },
    required: ['target'],
  },
  handler: async (input, ctx) => {
    const store = openTarget(ctx, input.target);
    if ('ok' in store) return store;
    try {
      const tree = await store.read();
      if (!tree) return missingApp(store);
      const path = codeFileKey(tree.files, input.path);
      if (!path) {
        const files = Object.keys(tree.files)
          .sort()
          .map((p) => ({
            path: p,
            bytes: Buffer.byteLength(tree.files[p]!, 'utf8'),
            lines: splitLines(tree.files[p]!).lines.length,
          }));
        ctx.step?.setOutput({ target: store.ref, files: files.length });
        return {
          ok: true,
          output: {
            target: store.ref,
            entry: tree.entry,
            rev: tree.rev,
            files,
            kit: store.kit(tree.entry),
          },
        };
      }
      if (!Object.hasOwn(tree.files, path)) return noFile(store, tree, path);
      // A CRLF file shows (and is edited) with LF; its writes keep CRLF.
      const view = numberedView(
        crlfOf(tree.files[path]!) ? toLf(tree.files[path]!) : tree.files[path]!,
        {
          start: typeof input.start === 'number' ? input.start : undefined,
          end: typeof input.end === 'number' ? input.end : undefined,
        },
        VIEW_MAX_LINES,
      );
      if ('error' in view) return { ok: false, error: `${view.error}. Pick a range inside it.` };
      ctx.step?.setOutput({ target: store.ref, path, lines: view.end - view.start + 1 });
      return {
        ok: true,
        output: {
          target: store.ref,
          path,
          rev: tree.rev,
          total_lines: view.total,
          start: view.start,
          end: view.end,
          text: view.text,
          ...(view.more
            ? {
                more: view.more,
                hint: `Cut at ${VIEW_MAX_LINES} lines: ${view.more} more. View on with start ${view.end + 1}.`,
              }
            : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: publicErrorText(err, 'code tools') };
    }
  },
};

const code_search: BuiltinToolDef = {
  slug: 'code_search',
  policy: READ_POLICY,
  name: 'Search source code',
  description:
    "Find text in a mini app's source: `file:line: text` hits in path order, capped (the result says how many there were in all). A plain substring by default; `regex: true` takes a JavaScript regular expression, stopped if it runs too long. `glob` narrows the files ('*.tsx', 'lib/**'). Reads the DRAFT, else the published code. Then read around a hit with `code_view`, or change it with `code_edit`. `code_view` with no path lists the files and what this target can use (language, allowed imports).",
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_PROP,
      pattern: {
        type: 'string',
        maxLength: PATTERN_MAX,
        minLength: 1,
        description: "What to find, e.g. 'useState' or 'host\\.db\\.(query|exec)'.",
      },
      regex: {
        type: 'boolean',
        default: false,
        description: 'Read pattern as a regular expression.',
      },
      glob: {
        type: 'string',
        maxLength: 200,
        description: "Only files whose path matches, e.g. '*.tsx' or 'lib/**'.",
      },
      ignore_case: {
        type: 'boolean',
        default: false,
        description: 'Match upper and lower case alike.',
      },
      max_results: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Max hits to return.',
      },
    },
    required: ['target', 'pattern'],
  },
  handler: async (input, ctx) => {
    const store = openTarget(ctx, input.target);
    if ('ok' in store) return store;
    const pattern = str(input.pattern);
    if (!pattern) return { ok: false, error: "pattern is required, e.g. 'useState'" };
    if (pattern.length > PATTERN_MAX) {
      return {
        ok: false,
        error: `pattern is ${pattern.length} characters; keep it under ${PATTERN_MAX}`,
      };
    }
    try {
      const tree = await store.read();
      if (!tree) return missingApp(store);
      const glob = str(input.glob).trim();
      const match = glob ? globMatcher(glob) : null;
      if (glob && !match) {
        return {
          ok: false,
          error: `glob '${glob}' is too large (too many {a,b} choices or too long): split it into narrower globs`,
        };
      }
      const files = match
        ? Object.fromEntries(Object.entries(tree.files).filter(([p]) => match(p)))
        : tree.files;
      if (match && Object.keys(files).length === 0) {
        return {
          ok: false,
          error: `glob '${glob}' matches no file in ${store.ref}. Its files: ${Object.keys(tree.files).sort().slice(0, 20).join(', ')}`,
        };
      }
      // The schema's bounds, kept here too (a run item reaches it unchecked).
      const asked = typeof input.max_results === 'number' ? Math.floor(input.max_results) : 50;
      const cap = Math.min(Math.max(asked, 1), 200);
      const res = await searchFiles(files, pattern, {
        regex: input.regex === true,
        ignoreCase: input.ignore_case === true,
        cap,
        caller: `${ctx.ownerId}:${actingLoginId(ctx.surface) ?? ctx.surface?.kind ?? ''}`,
      });
      if ('error' in res) return { ok: false, error: res.error };
      ctx.step?.setOutput({ target: store.ref, total: res.total });
      const truncated = res.total > res.hits.length;
      return {
        ok: true,
        output: {
          target: store.ref,
          rev: tree.rev,
          hits: res.hits,
          total: res.total,
          files: res.files,
          truncated,
          ...(truncated
            ? {
                hint: `Showing ${res.hits.length} of ${res.total} hits. Narrow the pattern or the glob, or raise max_results.`,
              }
            : res.total === 0
              ? {
                  hint: 'No hits. Check the spelling, try ignore_case, or list the files with code_view.',
                }
              : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: publicErrorText(err, 'code tools') };
    }
  },
};

const code_edit: BuiltinToolDef = {
  slug: 'code_edit',
  policy: WRITE_POLICY,
  ownerOnly: true,
  loginTurns: true,
  name: 'Edit source code',
  description:
    "Replace exact text in one file of a mini app's DRAFT; returns a unified diff and the new `rev`. Each edit's `old` must match exactly once (copy it from `code_view`, without line numbers) unless `replace_all`; else the call fails, says how many hits and on which lines, and changes nothing. All edits apply or none. `dry_run` returns the diff only. `build: true` runs `app_build` after. The published app is untouched until `app_publish`; `code_undo` with its `edit_id` takes it back. To add lines use `code_insert`; for a whole file use `code_write`. `code_view` with no path lists the files and what this target can use (language, allowed imports).",
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_PROP,
      path: PATH_PROP,
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: EDITS_MAX,
        description: 'Applied in order, each to the text the one before left.',
        items: {
          type: 'object',
          properties: {
            old: {
              type: 'string',
              minLength: 1,
              description: 'The exact text to replace, whitespace included.',
            },
            new: { type: 'string', description: 'What replaces it (empty removes it).' },
            replace_all: {
              type: 'boolean',
              default: false,
              description: 'Replace every match, not one.',
            },
          },
          required: ['old', 'new'],
          additionalProperties: false,
        },
      },
      dry_run: { type: 'boolean', default: false, description: 'Return the diff without writing.' },
      base_rev: BASE_REV_PROP,
      build: BUILD_PROP,
    },
    required: ['target', 'path', 'edits'],
  },
  handler: async (input, ctx) => {
    // The owner's surfaces only, first (as app_file_write).
    const refused = ownerOnlyRefusal(ctx);
    if (refused) return refused;
    const path = normCodePath(input.path);
    if (!path) return { ok: false, error: 'path is required, e.g. App.tsx' };
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { ok: false, error: 'edits needs at least one { old, new }' };
    }
    // The schema's cap, enforced here too: a run item reaches the handler
    // unchecked, and every edit runs under the app's row lock.
    if (input.edits.length > EDITS_MAX) {
      return {
        ok: false,
        error: `edits holds ${input.edits.length}; send at most ${EDITS_MAX} per call, or write the file with code_write`,
      };
    }
    const edits: TextEdit[] = [];
    let editChars = 0;
    for (const [i, e] of (input.edits as unknown[]).entries()) {
      const o = (e ?? {}) as Record<string, unknown>;
      if (typeof o.old !== 'string' || typeof o.new !== 'string') {
        return { ok: false, error: `edit ${i + 1} needs old and new as text` };
      }
      edits.push({ old: o.old, new: o.new, replace_all: o.replace_all === true });
      editChars += o.old.length + o.new.length;
    }
    if (editChars > 2 * MAX_APP_FILE_BYTES) {
      return {
        ok: false,
        error: 'the edits are larger than the file may be: write the file with code_write instead',
      };
    }
    let replaced = 0;
    const res = await writeFile(
      ctx,
      input,
      (tree) => {
        const key = codeFileKey(tree.files, input.path);
        if (!Object.hasOwn(tree.files, key)) {
          throw new ChangeRefused(
            `no file '${path}' in the app: list the files with code_view, or create it with code_write`,
          );
        }
        const file = tree.files[key]!;
        const crlf = crlfOf(file);
        const out = applyEdits(
          crlf ? toLf(file) : file,
          crlf ? edits.map((e) => ({ ...e, old: toLf(e.old), new: toLf(e.new) })) : edits,
          MAX_APP_FILE_BYTES,
        );
        if ('error' in out) throw new ChangeRefused(`${out.error} (${path})`);
        replaced = out.replaced;
        const text = crlf ? toCrlf(out.text) : out.text;
        return { tree: { entry: tree.entry, files: { ...tree.files, [key]: text } }, path: key };
      },
      { note: `code_edit ${path}`, dryRun: input.dry_run === true },
    );
    if (res.ok) (res.output as Record<string, unknown>).replaced = replaced;
    return res;
  },
};

const code_insert: BuiltinToolDef = {
  slug: 'code_insert',
  policy: WRITE_POLICY,
  ownerOnly: true,
  loginTurns: true,
  name: 'Insert lines into source code',
  description:
    "Insert lines into one file of a mini app's DRAFT after line `after_line` (0: at the top; the file's line count: at the end); returns a diff and the new `rev`. Line numbers come from `code_view`: pass its `rev` as `base_rev`, so a draft changed since is refused rather than written at a moved line. `build: true` runs `app_build` after. For a change inside existing lines use `code_edit`. `code_view` with no path lists the files and what this target can use (language, allowed imports).",
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_PROP,
      path: PATH_PROP,
      after_line: {
        type: 'integer',
        minimum: 0,
        description: 'The line to insert after; 0 is the top.',
      },
      text: { type: 'string', minLength: 1, description: 'The lines to insert.' },
      base_rev: BASE_REV_PROP,
      build: BUILD_PROP,
    },
    required: ['target', 'path', 'after_line', 'text'],
  },
  handler: async (input, ctx) => {
    // The owner's surfaces only, first (as app_file_write).
    const refused = ownerOnlyRefusal(ctx);
    if (refused) return refused;
    const path = normCodePath(input.path);
    if (!path) return { ok: false, error: 'path is required, e.g. App.tsx' };
    const after = input.after_line;
    if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) {
      return { ok: false, error: 'after_line must be a whole number, 0 for the top' };
    }
    const text = str(input.text);
    if (!text) return { ok: false, error: 'text is required: the lines to insert' };
    return writeFile(
      ctx,
      input,
      (tree) => {
        const key = codeFileKey(tree.files, input.path);
        if (!Object.hasOwn(tree.files, key)) {
          throw new ChangeRefused(
            `no file '${path}' in the app: list the files with code_view, or create it with code_write`,
          );
        }
        const file = tree.files[key]!;
        if (file.length + text.length > MAX_APP_FILE_BYTES) {
          throw new ChangeRefused(
            `the insert would take '${path}' past the file limit of ${MAX_APP_FILE_BYTES} bytes: insert less, or split the file`,
          );
        }
        const crlf = crlfOf(file);
        const out = insertAfterLine(crlf ? toLf(file) : file, after, crlf ? toLf(text) : text);
        if ('error' in out) throw new ChangeRefused(`${out.error} (${path})`);
        const next = crlf ? toCrlf(out.text) : out.text;
        return { tree: { entry: tree.entry, files: { ...tree.files, [key]: next } }, path: key };
      },
      { note: `code_insert ${path}` },
    );
  },
};

const code_write: BuiltinToolDef = {
  slug: 'code_write',
  policy: { ...WRITE_POLICY, idempotent: true },
  ownerOnly: true,
  loginTurns: true,
  name: 'Write a source file',
  description:
    "Create or replace one whole file in a mini app's DRAFT; returns the new `rev`, and a diff when it replaced a file. For a change of a few lines use `code_edit`, which sends less and leaves the rest alone. `base_rev` refuses a draft changed since you read it. `build: true` runs `app_build` after. The published app is untouched until `app_publish`; `code_undo` with its `edit_id` takes it back. `code_view` with no path lists the files and what this target can use (language, allowed imports). " +
    WHO_HINT,
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_PROP,
      path: PATH_PROP,
      content: { type: 'string', description: 'The whole file (TSX/TS).' },
      base_rev: BASE_REV_PROP,
      build: BUILD_PROP,
    },
    required: ['target', 'path', 'content'],
  },
  handler: async (input, ctx) => {
    // The owner's surfaces only, first (as app_file_write).
    const refused = ownerOnlyRefusal(ctx);
    if (refused) return refused;
    const path = normCodePath(input.path);
    if (typeof input.content !== 'string') {
      return { ok: false, error: 'content is required: the whole file text' };
    }
    const content = input.content;
    return writeFile(
      ctx,
      input,
      (tree) => {
        // A file the tree holds under the exact key is replaced there; a
        // new one takes the normalised path, which must stay inside the app.
        const key = codeFileKey(tree.files, input.path);
        if (!Object.hasOwn(tree.files, key)) {
          const bad = badNewPath(key);
          if (bad) throw new ChangeRefused(bad);
        }
        return { tree: { entry: tree.entry, files: { ...tree.files, [key]: content } }, path: key };
      },
      { note: `code_write ${path}` },
    );
  },
};

const code_undo: BuiltinToolDef = {
  slug: 'code_undo',
  policy: WRITE_POLICY,
  ownerOnly: true,
  loginTurns: true,
  name: 'Undo a source edit',
  description:
    "Take back one write to a mini app's DRAFT: `edit_id` (every write returns one), or with only `path` the newest write of that file (a second such call redoes; pass `edit_id`s to go further back). Its files go back as before it (a file it created is removed), only if each is still as that write left it; else it fails and changes nothing: change the file with `code_edit` or `code_write`. Returns its own `edit_id`, a diff and the new `rev`. Only recent writes are kept; for an earlier version use `app_snapshot_restore`. `code_view` with no path lists the files and what this target can use (language, allowed imports).",
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_PROP,
      edit_id: {
        type: 'string',
        description: 'The write to take back, from its result, e.g. 6f1c…',
      },
      path: {
        type: 'string',
        description:
          "Without edit_id: undo the newest write of this file. With it: only this file of that write. E.g. 'App.tsx'.",
      },
      base_rev: BASE_REV_PROP,
    },
    required: ['target'],
  },
  handler: async (input, ctx) => {
    // The owner's surfaces only, first (as app_file_write).
    const refused = ownerOnlyRefusal(ctx);
    if (refused) return refused;
    const store = openTarget(ctx, input.target);
    if ('ok' in store) return store;
    const editId = str(input.edit_id).trim() || null;
    if (editId && !UUID_RE.test(editId)) {
      return {
        ok: false,
        error: `edit_id '${editId.slice(0, 60)}' is not one: copy it from the write's result`,
      };
    }
    if (!editId && !normCodePath(input.path)) {
      return {
        ok: false,
        error: 'give the edit_id of the write to take back, or a path to undo its newest write',
      };
    }
    try {
      const tree = await store.read();
      if (!tree) return missingApp(store);
      const path = normCodePath(input.path) ? codeFileKey(tree.files, input.path) : null;
      const baseRev = str(input.base_rev).trim() || null;
      const res = await store.undo({ editId, path, baseRev });
      if (!res) return missingApp(store);
      ctx.step?.setOutput({ target: store.ref, undid: res.undid, files: res.files.length });
      const files = res.files.map((p, i) =>
        !Object.hasOwn(res.after.files, p)
          ? { path: p, removed: true }
          : i < UNDO_DIFFS_MAX
            ? {
                path: p,
                diff: unifiedDiff(p, toLf(res.before.files[p] ?? ''), toLf(res.after.files[p]!)),
              }
            : { path: p, restored: true, hint: 'view it with code_view' },
      );
      return {
        ok: true,
        output: {
          target: store.ref,
          undid: res.undid,
          edit_id: res.editId,
          rev: res.rev,
          files,
          hint: 'Taken back in the DRAFT. Build with app_build; code_undo with this edit_id puts the change back.',
        },
      };
    } catch (err) {
      return writeError(err);
    }
  },
};

/** The code tools, the writes under the app tools' author ceiling (read
 *  from the target). */
export const CODE_TOOLS: BuiltinToolDef[] = [
  code_view,
  code_search,
  ...CODE_HISTORY_TOOLS,
  code_edit,
  code_insert,
  code_write,
  code_undo,
].map((def) =>
  withAuthorCeiling(
    def,
    (input) => appIdOfCodeTarget(input.target),
    // code_edit alone has a dry run that writes nothing.
    def.slug === 'code_edit' ? { dryRun: true } : {},
  ),
);

export const CODE_TOOL_SLUGS: string[] = CODE_TOOLS.map((t) => t.slug);
