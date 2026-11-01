/**
 * code_diff: compare two states of a mini app's source, for an audit. A
 * state is the DRAFT, the LIVE (published) code, or an entry of the app's
 * history by its seq (a version a publish made, or a snapshot): its
 * published tree only, never the draft a snapshot kept beside it
 * (@mantle/content app-snapshots appHistorySource reads the one field).
 *
 * A read, with the history list's rights (app_snapshot_list): a read of the
 * app, `ownerOnly` + `loginTurns`. The draft side is the draft the scope may
 * see (the app's read keeps it from a caller that may not edit), else the
 * live code, and the answer says which. The line itself is `app_log`; the
 * whole line as git commits is `app_export` with format git.
 */
import { getApp, type AppDetail } from '@mantle/content';
import { appHistorySource } from '@mantle/content/app-snapshots';
import type { AppSource } from '@mantle/db';
import { publicErrorText } from '@mantle/std';
import { ownerOnlyRefusal } from '../builtins-apps';
import { str } from '../coerce';
import { notFound } from '../errors';
import type { ToolPolicy } from '../tool-policy';
import type { BuiltinToolDef } from '../types';
import { appIdOfCodeTarget, APP_TARGET_PREFIX, codeFileKey, normCodePath } from './target-ref';
import { DIFF_MAX_CELLS, splitLines, toLf, unifiedDiff } from './text';

/** Diff lines one file shows at most when all files are compared. */
const FILE_DIFF_LINES = 400;
/** Diff lines one file shows at most when one `path` is asked. */
const ONE_FILE_DIFF_LINES = 2000;
/** Diff lines all files together show at most; the files past it are
 *  listed with no diff. */
const ALL_DIFF_LINES = 1500;
/** The line-match work one call may do over all its files (DIFF_MAX_CELLS
 *  is one file's); past it a file's change shows as a whole-block replace. */
const ALL_DIFF_CELLS = 5 * DIFF_MAX_CELLS;

type Fail = { ok: false; error: string };

/** A side of the compare, as asked. */
type Ref = { kind: 'draft' } | { kind: 'live' } | { kind: 'entry'; seq: number };

/** A side as read: its tree and what it was. */
type Side = {
  ref: string;
  tree: AppSource;
  seq?: number;
  trigger?: string;
  at?: string;
  /** The draft side when there is no draft the caller sees: the live code. */
  noDraft?: true;
};

const REF_HINT =
  "'draft', 'live', or an entry of the app's history by its seq, e.g. 'v3' (app_log lists them)";

/** A ref as written: draft, live, or a seq (`v3`, `3`, `#3`). */
export function parseDiffRef(raw: unknown, fallback: 'draft' | 'live'): Ref | Fail {
  const v = str(raw).trim().toLowerCase();
  if (!v) return { kind: fallback };
  if (v === 'draft') return { kind: 'draft' };
  if (v === 'live' || v === 'published') return { kind: 'live' };
  const m = /^[v#]?(\d{1,9})$/.exec(v);
  if (m && Number(m[1]) > 0) return { kind: 'entry', seq: Number(m[1]) };
  return { ok: false, error: `ref '${v.slice(0, 40)}' must be ${REF_HINT}` };
}

async function readSide(
  ownerId: string,
  app: AppDetail,
  id: string,
  ref: Ref,
): Promise<Side | Fail> {
  if (ref.kind === 'draft') {
    return app.draft
      ? { ref: 'draft', tree: app.draft }
      : { ref: 'draft', tree: app.source, noDraft: true };
  }
  if (ref.kind === 'live') return { ref: 'live', tree: app.source };
  const entry = await appHistorySource(ownerId, id, ref.seq);
  if (!entry?.source) {
    return {
      ok: false,
      error: `app ${id} has no history entry v${ref.seq}: pick a seq that app_log lists, or 'draft' / 'live'`,
    };
  }
  return {
    ref: `v${entry.seq}`,
    tree: entry.source,
    seq: entry.seq,
    trigger: entry.trigger,
    at: entry.createdAt,
  };
}

const describeSide = (s: Side) => ({
  ref: s.ref,
  ...(s.seq !== undefined ? { seq: s.seq, trigger: s.trigger, at: s.at } : {}),
  entry: s.tree.entry,
  files: Object.keys(s.tree.files).length,
  ...(s.noDraft ? { no_draft: true } : {}),
});

const code_diff: BuiltinToolDef = {
  slug: 'code_diff',
  policy: {
    matrix: { action: 'read', param: 'target', kinds: ['app'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'apps',
  } satisfies ToolPolicy,
  ownerOnly: true,
  loginTurns: true,
  name: 'Compare source versions',
  description:
    "Compare two states of a mini app's source as unified diffs: `from` and `to` are 'draft', 'live' (published) or a history entry by seq ('v3': a version or a snapshot's code). Defaults: live to draft, what publishing would change. All files, or one `path`. Long diffs are cut and say so. Reads only. For the list of versions and who made them use `app_log`; to put an old version back use `app_snapshot_restore`; for the whole history as git commits use `app_export` with format git.",
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: "The app: app:<id>, the app's id from `app_list`, e.g. app:3f2a…",
      },
      from: {
        type: 'string',
        maxLength: 40,
        description: "The old side: 'draft', 'live' or a seq like 'v3'.",
        default: 'live',
      },
      to: {
        type: 'string',
        maxLength: 40,
        description: "The new side: 'draft', 'live' or a seq like 'v5'.",
        default: 'draft',
      },
      path: {
        type: 'string',
        description: "Only this file, e.g. 'App.tsx'.",
      },
    },
    required: ['target'],
  },
  handler: async (input, ctx) => {
    const refused = ownerOnlyRefusal(ctx);
    if (refused) return refused;
    const id = appIdOfCodeTarget(input.target);
    if (!id) {
      const shown =
        typeof input.target === 'string' && input.target.trim()
          ? `'${input.target.trim().slice(0, 80)}'`
          : 'it';
      return {
        ok: false,
        error: `target ${shown} names no source tree: write app:<id>, the app's id from app_list`,
      };
    }
    const from = parseDiffRef(input.from, 'live');
    if ('ok' in from) return from;
    const to = parseDiffRef(input.to, 'draft');
    if ('ok' in to) return to;
    try {
      const app = await getApp(ctx.ownerId, id);
      if (!app) return notFound('app', id, 'app_list');
      const a = await readSide(ctx.ownerId, app, id, from);
      if ('ok' in a) return a;
      const b = await readSide(ctx.ownerId, app, id, to);
      if ('ok' in b) return b;
      const target = `${APP_TARGET_PREFIX}${id}`;

      const asked = normCodePath(input.path);
      let paths: string[];
      if (asked) {
        const inA = codeFileKey(a.tree.files, input.path);
        const inB = codeFileKey(b.tree.files, input.path);
        const key = Object.hasOwn(b.tree.files, inB) ? inB : inA;
        if (!Object.hasOwn(a.tree.files, key) && !Object.hasOwn(b.tree.files, key)) {
          const all = [
            ...new Set([...Object.keys(a.tree.files), ...Object.keys(b.tree.files)]),
          ].sort();
          return {
            ok: false,
            error: `no file '${asked}' in ${a.ref} or ${b.ref}. Its files: ${all.slice(0, 20).join(', ')}${all.length > 20 ? ', …' : ''}`,
          };
        }
        paths = [key];
      } else {
        paths = [...new Set([...Object.keys(a.tree.files), ...Object.keys(b.tree.files)])].sort();
      }

      const cutHint = asked
        ? 'compare fewer versions apart, or read the file with code_view (the draft)'
        : 'pass path for that one file';
      let budget = ALL_DIFF_LINES;
      let cells = ALL_DIFF_CELLS;
      let coarse = 0;
      let unchanged = 0;
      let omitted = 0;
      const files: Record<string, unknown>[] = [];
      for (const p of paths) {
        const had = Object.hasOwn(a.tree.files, p);
        const has = Object.hasOwn(b.tree.files, p);
        const before = had ? toLf(a.tree.files[p]!) : '';
        const after = has ? toLf(b.tree.files[p]!) : '';
        if (had && has && before === after) {
          unchanged++;
          continue;
        }
        const change = !had ? 'added' : !has ? 'removed' : 'modified';
        if (!asked && budget <= 0) {
          omitted++;
          files.push({ path: p, change, diff_omitted: true });
          continue;
        }
        const max = asked ? ONE_FILE_DIFF_LINES : Math.min(FILE_DIFF_LINES, budget);
        // The match's cost at most (before the common head and tail go).
        const cost = splitLines(before).lines.length * splitLines(after).lines.length;
        const allowed = Math.min(DIFF_MAX_CELLS, cells);
        if (cost > allowed) coarse++;
        cells -= Math.min(cost, allowed);
        const diff = unifiedDiff(p, before, after, max, cutHint, allowed);
        budget -= diff.split('\n').length;
        files.push({ path: p, change, diff });
      }
      ctx.step?.setOutput({ target, from: a.ref, to: b.ref, changed: files.length });
      const notes: string[] = [];
      if (a.noDraft || b.noDraft) {
        notes.push('There is no draft you can see, so the draft side is the live code.');
      }
      if (omitted) {
        notes.push(
          `${omitted} changed file(s) are listed without a diff (the answer's limit): pass path for one.`,
        );
      }
      if (coarse) {
        notes.push(
          `${coarse} file diff(s) may show a large change as whole blocks (the compare's work limit): pass path for one.`,
        );
      }
      if (files.length === 0) notes.push(`No change between ${a.ref} and ${b.ref}.`);
      return {
        ok: true,
        output: {
          target,
          from: describeSide(a),
          to: describeSide(b),
          ...(a.tree.entry !== b.tree.entry
            ? { entry_changed: { from: a.tree.entry, to: b.tree.entry } }
            : {}),
          changed: files.length,
          unchanged,
          files,
          ...(notes.length ? { hint: notes.join(' ') } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: publicErrorText(err, 'code tools') };
    }
  },
};

export const CODE_HISTORY_TOOLS: BuiltinToolDef[] = [code_diff];
