/**
 * Extractor: an app's generated summary (Journal v3, J9).
 *
 * An app is not on the extractor's default type list (its code is not prose
 * to summarise), so its index used to be nothing. When it is published
 * without an author's summary, its extract job makes ONE summarizer call
 * here: the type-allowlist branch of admitForExtraction asks for it, then
 * indexes the app from it (writePublishedSummaryIndex). Written through
 * @mantle/db published-summary.ts, so an author's summary always wins.
 *
 * Cost: content has one spending path, the extract job, with its gates in
 * front of this call: the extractor worker on, the type list, the job queue
 * (one job per node at a time), and here llmWorkAllowed (the item is read by
 * a workspace with an assistant) and the hash (a publish that changed
 * neither the code nor the manifest makes no second call). Never in a
 * request or on a timer. Never a retry: a failed call is a skip, never a
 * throw, so pg-boss does not repeat a paid call; the next publish asks again.
 */
import { eq } from 'drizzle-orm';
import {
  apps,
  db,
  nodes,
  bumpWorkerUsage,
  llmWorkAllowed,
  newPublishedSummary,
  planPublishedSummary,
  readPublishedSummary,
  writePublishedSummary,
} from '@mantle/db';
import { resolveDefaultWorker } from '@mantle/api-keys';
import { getChatAdapter } from '@mantle/voice';
import { appSummaryHash, sourceToText } from '@mantle/content';
import { backgroundFence, errorMessage, withFenceNote } from '@mantle/std';
import { log, startTrace, step } from '@mantle/tracing';

const logger = log('app-summary');

/** The most of an app's own text the call reads (a hard input cap). */
export const APP_SUMMARY_INPUT_MAX_CHARS = 12_000;
/** Of which its source may take this much, its schema this much. */
const APP_SOURCE_MAX_CHARS = 8_000;
const APP_SCHEMA_MAX_CHARS = 3_000;
/** The reply's ceiling, in tokens: a few sentences. */
const MAX_REPLY_TOKENS = 400;

export const APP_SUMMARY_PROMPT = `You write the catalogue summary of one mini app in a workspace. People and agents find the app by this summary and decide from it whether to open it.

Write plain text, at most 600 characters, no markdown, no lists, no preamble. Say what the app is, who it is for and how to use it. Name the data tables it keeps and what each holds. Name things as the app names them. Never invent features the material does not show.`;

/** An app's summary input: what it says it is, its tools, its schema and
 *  the start of its code. */
export function appSummaryBody(app: {
  manifest: { description?: string; toolSlugs?: string[]; sqlite?: { schemaSql: string } };
  source: { entry: string; files: Record<string, string> };
}): string {
  const m = app.manifest ?? {};
  const parts = [
    m.description ? `Description: ${m.description}` : '',
    m.toolSlugs?.length ? `Tools it calls: ${m.toolSlugs.join(', ')}` : '',
    m.sqlite?.schemaSql
      ? `Database schema (SQLite):\n${m.sqlite.schemaSql.slice(0, APP_SCHEMA_MAX_CHARS)}`
      : 'Database schema: none declared',
    `Source (entry ${app.source.entry}, the start of it):\n${sourceToText(app.source).slice(0, APP_SOURCE_MAX_CHARS)}`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** The model input of the call. Pure, so the prompt can be pinned. */
export function buildAppSummaryMessages(
  title: string,
  body: string,
  fence = backgroundFence(),
): { system: string; user: string } {
  return {
    system: withFenceNote(APP_SUMMARY_PROMPT, fence),
    user: fence.wrap(
      `Kind: mini app\nTitle: ${title}\n\n${body}`.slice(0, APP_SUMMARY_INPUT_MAX_CHARS),
    ),
  };
}

/** What the extract job got from summarizeAppForIndex. */
export type AppSummaryOutcome = {
  /** The node as it is now (re-read after a write). */
  node: typeof nodes.$inferSelect;
  /**
   * 'written': one call made and its summary written; 'failed': the call
   * was made (or its answer could not be written) and there is no new
   * summary; 'none': no call (not an app with published code, a summary
   * kept, no assistant reads it, or no summarizer wired).
   */
  status: 'written' | 'failed' | 'none';
};

/**
 * Make an app's summary in its extract job, when its published code has
 * none (planPublishedSummary says generate). At most ONE summarizer call.
 * Never throws once the call is made: a failure is { status: 'failed' }.
 * A database error before the call throws as any extract read does (no
 * spend yet, so a pg-boss retry costs nothing).
 */
export async function summarizeAppForIndex(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<AppSummaryOutcome> {
  const none: AppSummaryOutcome = { node, status: 'none' };
  if (node.type !== 'app') return none;
  const [app] = await db
    .select({ source: apps.source, manifest: apps.manifest, published: apps.publishedBuild })
    .from(apps)
    .where(eq(apps.nodeId, node.id))
    .limit(1);
  // Never published: nothing live to summarise (a draft is never indexed).
  if (!app?.published) return none;
  const hash = appSummaryHash(app.source, app.manifest);
  const plan = planPublishedSummary(readPublishedSummary(node.data), null, hash);
  if (plan.do !== 'generate') return none;
  // The extractor's cost guard: no workspace with an assistant reads it.
  if (!(await llmWorkAllowed(node.id))) return none;
  const route = await resolveDefaultWorker(
    ownerId,
    'summarizer',
    (w) => getChatAdapter(w.provider) !== null,
  );
  if (!route.ok) return none;

  // From here a model may be paid: nothing below throws.
  try {
    const made = await callSummarizer(ownerId, node, route, {
      title: node.title,
      body: appSummaryBody({ manifest: app.manifest, source: app.source }),
    });
    const summary = made ? newPublishedSummary(made.text, 'publish', hash, made.model) : null;
    if (!summary) return { node, status: 'failed' };
    // Written at once, before any embedding: a later failure that retries
    // the job finds it kept (the same hash) and calls nothing.
    await writePublishedSummary(db, node.id, summary);
    const [fresh] = await db.select().from(nodes).where(eq(nodes.id, node.id)).limit(1);
    return { node: fresh ?? node, status: 'written' };
  } catch (err) {
    logger.warn(`${node.id}: no summary (${errorMessage(err)})`);
    return { node, status: 'failed' };
  }
}

/** The one call, traced as a summarizer run. Null on a failed call or an
 *  empty reply; never throws. */
async function callSummarizer(
  ownerId: string,
  node: { id: string },
  route: Extract<Awaited<ReturnType<typeof resolveDefaultWorker>>, { ok: true }>,
  input: { title: string; body: string },
): Promise<{ text: string; model: string } | null> {
  const { worker, credential } = route;
  const adapter = getChatAdapter(worker.provider);
  if (!adapter) return null;
  const { system, user } = buildAppSummaryMessages(input.title, input.body);
  try {
    return await startTrace(
      {
        kind: 'summarizer_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        data: {
          app_summary: true,
          worker_slug: worker.slug,
          model: worker.model,
          provider: worker.provider,
        },
      },
      () =>
        step(
          {
            name: 'llm_app_summary',
            kind: 'llm_call',
            input: { model: worker.model, body_chars: input.body.length },
          },
          async (h) => {
            const r = await adapter.chat({
              ...credential,
              model: worker.model,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              temperature: 0.2,
              maxTokens: MAX_REPLY_TOKENS,
            });
            void bumpWorkerUsage(worker.id);
            h.setOutput({ chars: r.text.length });
            return r.text.trim() ? { text: r.text, model: worker.model } : null;
          },
        ),
    );
  } catch (err) {
    logger.warn(`${node.id}: the summarizer failed (${errorMessage(err)})`);
    return null;
  }
}
