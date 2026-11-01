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
  CannotDeleteEntryError,
  changeDraftSource,
  getApp,
  sourceRev,
  undoDraftFile,
  workingSource,
  type DraftChange,
} from '@mantle/content';
import type { AppSource } from '@mantle/db';
import { publicErrorText } from '@mantle/std';
import { buildAndStageApp } from '../app-build-stage';
import { historyActor, ownerOnlyRefusal, withAuthorCeiling, WHO_HINT } from '../builtins-apps';
import { CS } from '../client-sourced-rule';
import { str } from '../coerce';
import { notFound } from '../errors';
import type { ToolPolicy } from '../tool-policy';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from '../types';
import { searchFiles } from './search';
import { appIdOfCodeTarget, APP_TARGET_PREFIX } from './target-ref';
import {
  applyEdits,
  globToRegExp,
  insertAfterLine,
  numberedView,
  splitLines,
  unifiedDiff,
  type TextEdit,
} from './text';

/** Lines one code_view returns at most; a longer range says where to go on. */
export const VIEW_MAX_LINES = 2000;
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

/** What the tools need of a target kind. */
type CodeStore = {
  /** The target, as the tools write it back (`app:<id>`). */
  ref: string;
  read(): Promise<CodeTree | null>;
  change(
    fn: (tree: AppSource) => AppSource,
    opts: { baseRev: string | null; dryRun?: boolean; note: string },
  ): Promise<DraftChange | null>;
  undo(path: string): Promise<DraftChange | null>;
  build(): Promise<BuildReport | null>;
};

/** An app's draft tree (else its published one). */
function appStore(ctx: Ctx, id: string): CodeStore {
  return {
    ref: `${APP_TARGET_PREFIX}${id}`,
    async read() {
      const app = await getApp(ctx.ownerId, id);
      if (!app) return null;
      const src = workingSource(app);
      return { entry: src.entry, files: src.files, rev: sourceRev(src) };
    },
    change: (fn, opts) =>
      changeDraftSource(ctx.ownerId, id, fn, {
        actor: historyActor(ctx),
        note: opts.note,
        baseRev: opts.baseRev,
        dryRun: opts.dryRun,
      }),
    undo: (path) => undoDraftFile(ctx.ownerId, id, path),
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
        hint: 'The edit is saved in the draft; the build failed. Fix the files at these places and write again with build: true. The last good preview is untouched.',
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

/** A file path as the tree keys it: no leading `./` or `/`. */
function normPath(raw: unknown): string {
  return str(raw)
    .trim()
    .replace(/^(\.\/|\/)+/, '');
}

/** A path a write may create: relative, no `..` or empty segment. */
function badNewPath(path: string): string | null {
  if (!path) return 'path is required, e.g. App.tsx or lib/fmt.ts';
  if (path.includes('\\') || path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return `path '${path}' must be relative inside the app, with no '..', '.' or empty part (e.g. lib/fmt.ts)`;
  }
  return null;
}

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
    err instanceof AppUndoEmptyError
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

/** Run a draft change that ends in one file's diff. */
async function writeFile(
  ctx: Ctx,
  input: Record<string, unknown>,
  fn: (tree: AppSource, path: string) => AppSource,
  opts: { note: string; dryRun?: boolean; path: string; newFile?: true },
): Promise<ToolHandlerResult> {
  const store = openTarget(ctx, input.target);
  if ('ok' in store) return store;
  const { path } = opts;
  try {
    const res = await store.change((tree) => fn(tree, path), {
      baseRev: str(input.base_rev).trim() || null,
      dryRun: opts.dryRun,
      note: opts.note,
    });
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
        ...(opts.dryRun ? { dry_run: true } : {}),
        written: res.written,
        ...(created
          ? { created: true, lines: splitLines(after).lines.length }
          : { diff: unifiedDiff(path, before, after) }),
        ...(await maybeBuild(store, input, res.written)),
        hint: opts.dryRun
          ? 'Dry run: nothing was written. Send the same call without dry_run to apply it.'
          : res.written
            ? 'Saved in the DRAFT. Build with app_build (or pass build: true); the published app changes only at app_publish.'
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
    "Read a mini app's source. With no `path`: the file tree (each file's size and line count), the entry file and the tree's `rev`. With a `path`: that file as numbered lines, only `start`..`end` when given. Reads the DRAFT, else the published code. Pass `rev` back as `base_rev` on a write. To find text across files use `code_search`; for the manifest and build state use `app_get`.",
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
      const path = normPath(input.path);
      if (!path) {
        const files = Object.keys(tree.files)
          .sort()
          .map((p) => ({
            path: p,
            bytes: Buffer.byteLength(tree.files[p]!, 'utf8'),
            lines: splitLines(tree.files[p]!).lines.length,
          }));
        ctx.step?.setOutput({ target: store.ref, files: files.length });
        return { ok: true, output: { target: store.ref, entry: tree.entry, rev: tree.rev, files } };
      }
      if (!Object.hasOwn(tree.files, path)) return noFile(store, tree, path);
      const view = numberedView(
        tree.files[path]!,
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
    "Find text in a mini app's source: `file:line: text` hits in path order, capped (the result says how many there were in all). A plain substring by default; `regex: true` takes a JavaScript regular expression, stopped if it runs too long. `glob` narrows the files ('*.tsx', 'lib/**'). Reads the DRAFT, else the published code. Then read around a hit with `code_view`, or change it with `code_edit`.",
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_PROP,
      pattern: {
        type: 'string',
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
    try {
      const tree = await store.read();
      if (!tree) return missingApp(store);
      const glob = str(input.glob).trim();
      const re = glob ? globToRegExp(glob) : null;
      const files = re
        ? Object.fromEntries(Object.entries(tree.files).filter(([p]) => re.test(p)))
        : tree.files;
      if (re && Object.keys(files).length === 0) {
        return {
          ok: false,
          error: `glob '${glob}' matches no file in ${store.ref}. Its files: ${Object.keys(tree.files).sort().slice(0, 20).join(', ')}`,
        };
      }
      const cap = typeof input.max_results === 'number' ? input.max_results : 50;
      const res = await searchFiles(files, pattern, {
        regex: input.regex === true,
        ignoreCase: input.ignore_case === true,
        cap,
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
    "Replace exact text in one file of a mini app's DRAFT; returns a unified diff and the new `rev`. Each edit's `old` must match exactly once (copy it from `code_view`, without line numbers) unless `replace_all`; else the call fails, says how many hits and on which lines, and changes nothing. All edits apply or none. `dry_run` returns the diff only. `build: true` runs `app_build` after. The published app is untouched until `app_publish`; `code_undo` puts the file back. To add lines use `code_insert`; for a whole file use `code_write`.",
  inputSchema: {
    type: 'object',
    properties: {
      target: TARGET_PROP,
      path: PATH_PROP,
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
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
    const path = normPath(input.path);
    if (!path) return { ok: false, error: 'path is required, e.g. App.tsx' };
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { ok: false, error: 'edits needs at least one { old, new }' };
    }
    const edits: TextEdit[] = [];
    for (const [i, e] of (input.edits as unknown[]).entries()) {
      const o = (e ?? {}) as Record<string, unknown>;
      if (typeof o.old !== 'string' || typeof o.new !== 'string') {
        return { ok: false, error: `edit ${i + 1} needs old and new as text` };
      }
      edits.push({ old: o.old, new: o.new, replace_all: o.replace_all === true });
    }
    let replaced = 0;
    const res = await writeFile(
      ctx,
      input,
      (tree) => {
        if (!Object.hasOwn(tree.files, path)) {
          throw new ChangeRefused(
            `no file '${path}' in the app: list the files with code_view, or create it with code_write`,
          );
        }
        const out = applyEdits(tree.files[path]!, edits);
        if ('error' in out) throw new ChangeRefused(`${out.error} (${path})`);
        replaced = out.replaced;
        return { entry: tree.entry, files: { ...tree.files, [path]: out.text } };
      },
      { note: `code_edit ${path}`, dryRun: input.dry_run === true, path },
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
    "Insert lines into one file of a mini app's DRAFT after line `after_line` (0: at the top; the file's line count: at the end); returns a diff and the new `rev`. Line numbers come from `code_view`: pass its `rev` as `base_rev`, so a draft changed since is refused rather than written at a moved line. `build: true` runs `app_build` after. For a change inside existing lines use `code_edit`.",
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
    const path = normPath(input.path);
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
        if (!Object.hasOwn(tree.files, path)) {
          throw new ChangeRefused(
            `no file '${path}' in the app: list the files with code_view, or create it with code_write`,
          );
        }
        const out = insertAfterLine(tree.files[path]!, after, text);
        if ('error' in out) throw new ChangeRefused(`${out.error} (${path})`);
        return { entry: tree.entry, files: { ...tree.files, [path]: out.text } };
      },
      { note: `code_insert ${path}`, path },
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
    "Create or replace one whole file in a mini app's DRAFT; returns the new `rev`, and a diff when it replaced a file. For a change of a few lines use `code_edit`, which sends less and leaves the rest alone. `base_rev` refuses a draft changed since you read it. `build: true` runs `app_build` after. The published app is untouched until `app_publish`; `code_undo` puts the old text back. " +
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
    const path = normPath(input.path);
    const bad = badNewPath(path);
    if (bad) return { ok: false, error: bad };
    if (typeof input.content !== 'string') {
      return { ok: false, error: 'content is required: the whole file text' };
    }
    const content = input.content;
    return writeFile(
      ctx,
      input,
      (tree) => ({ entry: tree.entry, files: { ...tree.files, [path]: content } }),
      { note: `code_write ${path}`, path },
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
    "Put one file of a mini app's DRAFT back as it was before the last write that changed it (`code_edit`, `code_insert`, `code_write`, `app_file_write`, `app_file_delete`, `app_source_set`); returns a diff and the new `rev`. Call it again to step further back. A file that write created is removed. Only recent edits are kept; for a whole earlier version use `app_snapshot_restore`.",
  inputSchema: {
    type: 'object',
    properties: { target: TARGET_PROP, path: PATH_PROP },
    required: ['target', 'path'],
  },
  handler: async (input, ctx) => {
    const refused = ownerOnlyRefusal(ctx);
    if (refused) return refused;
    const store = openTarget(ctx, input.target);
    if ('ok' in store) return store;
    const path = normPath(input.path);
    if (!path) return { ok: false, error: 'path is required, e.g. App.tsx' };
    try {
      const res = await store.undo(path);
      if (!res) return missingApp(store);
      const removed = !Object.hasOwn(res.after.files, path);
      ctx.step?.setOutput({ target: store.ref, path, rev: res.rev, removed });
      return {
        ok: true,
        output: {
          target: store.ref,
          path,
          rev: res.rev,
          ...(removed
            ? { removed: true }
            : { diff: unifiedDiff(path, res.before.files[path] ?? '', res.after.files[path]!) }),
          hint: 'Put back in the DRAFT. Build with app_build; call code_undo again to go one more step back.',
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
  code_edit,
  code_insert,
  code_write,
  code_undo,
].map((def) => withAuthorCeiling(def, (input) => appIdOfCodeTarget(input.target)));

export const CODE_TOOL_SLUGS: string[] = CODE_TOOLS.map((t) => t.slug);
