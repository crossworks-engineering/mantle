/**
 * The extractor's lane settings over MCP (docs/embeddings.md, the lanes; admin
 * settings are never screen-only): extractions at once, books at once and
 * the time budget, read and set as GET and PATCH /api/embedding/extraction
 * do, through the one reader and writer (@mantle/embeddings
 * extraction-settings.ts). The extractor re-reads them every 30 s, so a
 * save is live with no restart.
 *
 * `mcpOnly`: an Admin user's own client; no in-brain agent is granted them.
 * The settings area, run whole: they read and write the one embedding_config
 * row's lane columns and read the extract queue's counts (pgboss), take no
 * item id and read no brain item.
 */
import {
  clearEmbeddingModelCache,
  lanePatchProblem,
  readExtractionLaneSettings,
  saveExtractionLanePatch,
  type ExtractionLanePatch,
} from '@mantle/embeddings';
// The ranges from the pure module, read when this file loads: a test that
// mocks @mantle/embeddings leaves this one as it is.
import { LANE_SETTING_RANGES } from '@mantle/embeddings/extraction-concurrency';
import { extractionQueueCountsOrNull } from '@mantle/db';
import { publicErrorText } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { CS } from './client-sourced-rule';

const NOT_SET_UP =
  'Set up the embedder first (Settings, Embedding): the brain has no embedder row.';

export const extraction_get: BuiltinToolDef = {
  slug: 'extraction_get',
  mcpOnly: true,
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'settings', systemWhole: true },
    recipe: { step: 'forbidden' },
  },
  name: 'Read the extraction lane settings',
  description:
    "Read this box's extraction lane settings (Settings > Embedding, Performance): `concurrency` (extractions at once, light and heavy files together), `book_concurrency` (books at once: PDFs of 10 MB or more or of more than 200 pages, in their own lane beside the first) and `time_budget_minutes` (how long one extraction may run; a book's grows with its pages). Each gives `saved` (null: not saved), `effective` (what the extractor runs with now), `source` (`saved`, `env` or `default`), `default`, `min` and `max`. Also `configured` (false: no embedder yet, nothing can be saved) and `queue`, the extract queue's counts now. Read-only. To change one use `extraction_set`.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    try {
      const [settings, queue] = await Promise.all([
        readExtractionLaneSettings(ctx.ownerId),
        extractionQueueCountsOrNull(),
      ]);
      return { ok: true, output: { ...settings, queue } };
    } catch (err) {
      return { ok: false, error: publicErrorText(err, 'extraction_get') };
    }
  },
};

const { concurrency: C, bookConcurrency: B, timeBudgetMinutes: T } = LANE_SETTING_RANGES;

/** A value of the input: a number, null (clear), or absent. */
function inputValue(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === 'number' ? v : Number.NaN;
}

export const extraction_set: BuiltinToolDef = {
  slug: 'extraction_set',
  mcpOnly: true,
  policy: {
    matrix: { none: 'the extractor lane settings are not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings', systemWhole: true },
    peerRisky: true,
    idempotent: true, // sets values
    recipe: { step: 'forbidden' },
    clientSourced: CS.always('changes how many files this box extracts at once, and for how long'),
  },
  name: 'Set the extraction lane settings',
  description: `Set this box's extraction lane settings (Settings > Embedding, Performance). Give only what changes: a whole number sets it, null clears it (back to the env value, then the default). \`concurrency\`: extractions at once, ${C.min} to ${C.max}. \`book_concurrency\`: books at once in their own lane, ${B.min} to ${B.max}; books share the parser's one job slot, so above 1 helps only a box with parser room. \`time_budget_minutes\`: minutes one extraction may run before it is tried again, ${T.min} to ${T.max} (a book's grows with its pages). Live within 30 seconds, no restart; runs in flight finish. Returns what \`extraction_get\` does. Refused before the embedder is set up.`,
  inputSchema: {
    type: 'object',
    properties: {
      concurrency: {
        type: ['integer', 'null'],
        minimum: C.min,
        maximum: C.max,
        description: `Extractions at once (${C.min} to ${C.max}), or null for the env value or default.`,
      },
      book_concurrency: {
        type: ['integer', 'null'],
        minimum: B.min,
        maximum: B.max,
        description: `Books at once (${B.min} to ${B.max}), or null for the env value or default.`,
      },
      time_budget_minutes: {
        type: ['integer', 'null'],
        minimum: T.min,
        maximum: T.max,
        description: `Minutes one extraction may run (${T.min} to ${T.max}), or null for the env value or default.`,
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const patch: ExtractionLanePatch = {
      concurrency: inputValue(input.concurrency),
      bookConcurrency: inputValue(input.book_concurrency),
      timeBudgetMinutes: inputValue(input.time_budget_minutes),
    };
    const problem = lanePatchProblem(patch);
    if (problem) return { ok: false, error: problem };
    try {
      if (!(await saveExtractionLanePatch(ctx.ownerId, patch))) {
        return { ok: false, error: NOT_SET_UP };
      }
      clearEmbeddingModelCache(ctx.ownerId);
      return {
        ok: true,
        output: {
          ...(await readExtractionLaneSettings(ctx.ownerId)),
          next: 'The extractor applies it within 30 seconds; runs in flight finish.',
        },
      };
    } catch (err) {
      return { ok: false, error: publicErrorText(err, 'extraction_set') };
    }
  },
};

/** Registered on the MCP surface (build-server.ts); no agent is granted
 *  them. */
export const EXTRACTION_TOOLS: readonly BuiltinToolDef[] = [extraction_get, extraction_set];
