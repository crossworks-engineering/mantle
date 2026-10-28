/**
 * Publish-time summaries for apps and canvases (Journal v3, J9).
 *
 * An app's index used to be its raw source and a canvas's its visible text:
 * a drawing-heavy deck or a tool-made app summarised to almost nothing. So
 * the item gets a real summary when it is published (an app's publish, a
 * canvas's quiet-period flush), kept on the node through @mantle/db
 * published-summary.ts, which the extractor indexes instead of its own:
 *
 *  1. The author passes it (free): `summary` on app_publish, the publish
 *     route, present_create and present_update.
 *  2. Else ONE summarizer call writes it: the default `summarizer` worker
 *     (system manifest) over a capped input. An app: its manifest, its
 *     declared SQLite schema and the start of its source. A canvas: its
 *     text and its picture (the poster, or one render by the canvas
 *     renderer).
 *
 * Cost: user-triggered (a publish, or the settled moment after saves), never
 * on a save, never on a timer of its own. Skipped when the author's summary
 * is there, when what it would be made from did not change (the hash), when
 * the item is in no workspace an assistant reads (llmWorkAllowed, the
 * extractor's cost guard), and when no summarizer is wired. No retry: a
 * failed call leaves the item to the extractor's own summary.
 */
import { eq } from 'drizzle-orm';
import {
  db,
  nodes,
  presents,
  llmWorkAllowed,
  bumpWorkerUsage,
  newPublishedSummary,
  planPublishedSummary,
  readPublishedSummary,
  type PublishedSummary,
} from '@mantle/db';
import { resolveDefaultWorker } from '@mantle/api-keys';
import { getChatAdapter } from '@mantle/voice';
import { appSummaryHash, getApp, sourceToText } from '@mantle/content';
import { getPresent, presentSummaryHash } from '@mantle/content/presents';
import { backgroundFence, errorMessage, withFenceNote } from '@mantle/std';
import { startTrace, step } from '@mantle/tracing';
import { latestCanvasPicture } from './builtins-presents';

/** The most of an item's own text the call reads (a hard input cap). */
export const PUBLISH_SUMMARY_INPUT_MAX_CHARS = 12_000;
/** Of which an app's source may take this much, its schema this much. */
const APP_SOURCE_MAX_CHARS = 8_000;
const APP_SCHEMA_MAX_CHARS = 3_000;
/** A picture past this is not sent (a provider's per-image limit). */
const MAX_IMAGE_BYTES = 3_500_000;
/** The reply's ceiling, in tokens: a few sentences. */
const MAX_REPLY_TOKENS = 400;

export const PUBLISH_SUMMARY_PROMPT = `You write the catalogue summary of one item in a workspace: a mini app or a Present canvas (a deck, a diagram, a dashboard). People and agents find the item by this summary and decide from it whether to open it.

Write plain text, at most 600 characters, no markdown, no lists, no preamble. Say what the item is, who it is for and how to use it. For an app, name the data tables it keeps and what each holds. For a canvas with a picture, describe what the picture shows (the drawing, the slides, the figures) as well as its words. Name things as the item names them. Never invent features the material does not show.`;

/** A user turn's parts: the canvas's text and its picture (the chat
 *  adapters' multimodal user content). */
type UserPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string; detail?: 'auto' | 'low' | 'high' } };

/** What one summarizer call reads. */
export type PublishSummaryInput = {
  nodeId: string;
  kind: 'app' | 'present';
  title: string;
  /** The item's own text, capped by the caller's builder. */
  body: string;
  image?: { png: Buffer; mime: 'image/png' | 'image/jpeg' } | null;
};

/** The model input of one call. Pure, so the prompt can be pinned. */
export function buildPublishSummaryMessages(
  input: PublishSummaryInput,
  fence = backgroundFence(),
): { system: string; user: string | UserPart[] } {
  const material = fence.wrap(
    `Kind: ${input.kind === 'app' ? 'mini app' : 'Present canvas'}\nTitle: ${input.title}\n\n${input.body}`.slice(
      0,
      PUBLISH_SUMMARY_INPUT_MAX_CHARS,
    ),
  );
  const system = withFenceNote(PUBLISH_SUMMARY_PROMPT, fence);
  const image = input.image && input.image.png.length <= MAX_IMAGE_BYTES ? input.image : null;
  if (!image) return { system, user: material };
  return {
    system,
    user: [
      { type: 'text', text: `${material}\n\nThe picture is the canvas as it is drawn.` },
      {
        type: 'image_url',
        imageUrl: {
          url: `data:${image.mime};base64,${image.png.toString('base64')}`,
          detail: 'low',
        },
      },
    ],
  };
}

/**
 * One summarizer call, or null: no summarizer wired, the item in no
 * workspace an assistant reads, a failed call, an empty reply. Never
 * throws; the trace (summarizer_run) records what happened.
 */
export async function summarizeForPublish(
  ownerId: string,
  input: PublishSummaryInput,
): Promise<{ text: string; model: string } | null> {
  try {
    if (!(await llmWorkAllowed(input.nodeId))) return null;
    const route = await resolveDefaultWorker(
      ownerId,
      'summarizer',
      (w) => getChatAdapter(w.provider) !== null,
    );
    if (!route.ok) return null;
    const { worker, credential } = route;
    const adapter = getChatAdapter(worker.provider)!;
    const { system, user } = buildPublishSummaryMessages(input);
    return await startTrace(
      {
        kind: 'summarizer_run',
        ownerId,
        subjectId: input.nodeId,
        subjectKind: 'node',
        data: {
          publish_summary: true,
          node_type: input.kind,
          worker_slug: worker.slug,
          model: worker.model,
          provider: worker.provider,
        },
      },
      () =>
        step(
          {
            name: 'llm_publish_summary',
            kind: 'llm_call',
            input: {
              model: worker.model,
              body_chars: input.body.length,
              image: typeof user !== 'string',
            },
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
    console.warn(`[publish-summary] ${input.nodeId}: no summary (${errorMessage(err)})`);
    return null;
  }
}

/** The kept published summary of a node (one read). */
async function keptSummary(nodeId: string): Promise<PublishedSummary | null> {
  const [row] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  return readPublishedSummary(row?.data);
}

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

/**
 * The summary an app publish writes (publishApp's `summary`), or null when
 * it keeps the one it has or none can be made. `given` is the author's.
 * Spends nothing when the author gave one, when the code and manifest are
 * the ones the kept summary was made from, or when the publish would be
 * refused (no green build).
 */
export async function appPublishSummary(
  ownerId: string,
  id: string,
  given?: string | null,
  /** False: the caller may not spend on the owner's keys (a direct MCP,
   *  key or peer call outside an Admin scope, ownerKeysOff): an author's
   *  summary only, never a call. */
  opts: { generate?: boolean } = {},
): Promise<PublishedSummary | null> {
  // A summary is never a reason for a publish to fail.
  return appPublishSummaryOrThrow(ownerId, id, given, opts.generate !== false).catch(
    (err: unknown) => {
      console.warn(`[publish-summary] ${id}: no summary (${errorMessage(err)})`);
      return null;
    },
  );
}

async function appPublishSummaryOrThrow(
  ownerId: string,
  id: string,
  given: string | null | undefined,
  generate: boolean,
): Promise<PublishedSummary | null> {
  const app = await getApp(ownerId, id);
  if (!app) return null;
  const source = app.draft ?? app.source;
  const hash = appSummaryHash(source, app.manifest);
  const plan = planPublishedSummary(await keptSummary(id), given, hash);
  if (plan.do === 'write') return plan.summary;
  if (plan.do === 'keep' || !generate || !app.draftBuild?.ok) return null;
  const made = await summarizeForPublish(ownerId, {
    nodeId: id,
    kind: 'app',
    title: app.title,
    body: appSummaryBody({ manifest: app.manifest, source }),
  });
  return made ? newPublishedSummary(made.text, 'publish', hash, made.model) : null;
}

/**
 * The summary a canvas's quiet-period flush writes (flushDuePresentIndex's
 * hook), or null when it keeps the one it has (the author's, or one made
 * from this source) or none can be made.
 */
export async function presentPublishSummary(canvas: {
  id: string;
  ownerId: string;
}): Promise<PublishedSummary | null> {
  const p = await getPresent(canvas.ownerId, canvas.id);
  if (!p) return null;
  const hash = presentSummaryHash(p.source);
  const plan = planPublishedSummary(await keptSummary(p.id), null, hash);
  if (plan.do !== 'generate') return null;
  const text = (await canvasText(p.id)) ?? '';
  const made = await summarizeForPublish(canvas.ownerId, {
    nodeId: p.id,
    kind: 'present',
    title: p.title,
    body: [p.description ? `Description: ${p.description}` : '', `Canvas text:\n${text}`]
      .filter(Boolean)
      .join('\n\n'),
    image: await latestCanvasPicture(canvas.ownerId, p),
  });
  return made ? newPublishedSummary(made.text, 'publish', hash, made.model) : null;
}

/** The canvas's derived text (presents.source_text), as the extractor
 *  reads it. */
async function canvasText(id: string): Promise<string | null> {
  const [row] = await db
    .select({ text: presents.sourceText })
    .from(presents)
    .where(eq(presents.nodeId, id))
    .limit(1);
  return row?.text ?? null;
}
