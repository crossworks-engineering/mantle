/**
 * The author's summary at an app's publish (Journal v3, J9).
 *
 * The agent or client that built an app may pass `summary` with its publish
 * (app_publish, the publish route): kept as written through @mantle/db
 * published-summary.ts, and the extractor indexes it instead of its own.
 *
 * Nothing here calls a model. Without an author's summary, the app's extract
 * job writes one (server/api extract/app-summary.ts), behind the extractor's
 * own gates: one spending path for content.
 */
import { eq } from 'drizzle-orm';
import {
  db,
  nodes,
  planPublishedSummary,
  readPublishedSummary,
  type PublishedSummary,
} from '@mantle/db';
import { appSummaryHash, getApp } from '@mantle/content';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';

/**
 * The summary an app publish writes (publishApp's `summary`): the author's
 * `given` text, or null when none was given, when it is the one kept already,
 * or when the app cannot be read. Never throws: a summary is never a reason
 * for a publish to fail.
 */
export async function appAuthorSummary(
  ownerId: string,
  id: string,
  given?: string | null,
): Promise<PublishedSummary | null> {
  if (!given?.trim()) return null;
  try {
    const app = await getApp(ownerId, id);
    if (!app) return null;
    const [row] = await db
      .select({ data: nodes.data })
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1);
    const plan = planPublishedSummary(
      readPublishedSummary(row?.data),
      given,
      appSummaryHash(app.draft ?? app.source, app.manifest),
    );
    return plan.do === 'write' ? plan.summary : null;
  } catch (err) {
    log('publish-summary').warn(`${id}: no summary (${errorMessage(err)})`);
    return null;
  }
}
