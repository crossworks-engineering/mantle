/**
 * The answer cache (migration 0392; docs/provider-http.md, "Kept answers";
 * owner decision 2026-11-20). One rule: every paid AI answer of queue work is
 * kept before anything after it can wait, so a try again never pays for it
 * twice. A provider's "not now" is then only a wait: the job is sent again
 * with its growing gap, and nothing is counted.
 *
 * The worker gateway keeps and takes the answers (runVisionWorker and
 * runScanReader in @mantle/runtime, the extractor's call in server/api
 * extract/model.ts), keyed by sha256 of what was asked: the kind, the
 * provider and model, the prompt, and the input (its bytes' hash, or a name
 * the caller gives when the bytes of one input may differ between reads, as
 * a scanned page cut again). As embedding_cache, content addressed, no prune.
 *
 * Only inside withAnswerCache: the extract queue runs each job in it. Outside
 * (a chat turn, a test) nothing is read or written. A person's read again
 * (file_reindex) stamps the node (readAgainStampSql); its extract then takes
 * only answers kept after that moment (`since`), so it pays once for the read
 * the person asked for, and its own tries again after a wait still pay
 * nothing twice.
 *
 * A failed read is no answer (the call is made); a failed write is logged and
 * the answer in hand is used. Never throws.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import { errorMessage } from '@mantle/std';
import { systemDb } from './gateway/handles';
import { aiAnswerCache } from './schema/ai-answer-cache';

/** The kinds of answer kept. */
export type AnswerKind = 'vision' | 'scan_reader' | 'extractor';

const scopes = new AsyncLocalStorage<{ since: Date | null }>();

/**
 * Run `fn` with the answer cache on. `since`: only answers kept at or after
 * it are taken (a person's read again); null, any.
 */
export function withAnswerCache<T>(fn: () => Promise<T>, since: Date | null = null): Promise<T> {
  return scopes.run({ since }, fn);
}

/** The key of an answer: sha256 of its kind and the parts of what was asked. */
export function answerKey(kind: AnswerKind, parts: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, ...parts]))
    .digest('hex');
}

/** The sha256 of an input's bytes, for a key. */
export function bytesKey(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The kept answer of `key`, or null: none, too old for this read, no
 *  cache here, or the read failed. */
export async function keptAnswer<T>(key: string): Promise<T | null> {
  const scope = scopes.getStore();
  if (!scope) return null;
  try {
    const [row] = await systemDb
      .select({ answer: aiAnswerCache.answer })
      .from(aiAnswerCache)
      .where(
        and(
          eq(aiAnswerCache.key, key),
          scope.since ? gte(aiAnswerCache.createdAt, scope.since) : undefined,
        ),
      )
      .limit(1);
    return (row?.answer as T | undefined) ?? null;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/** Keep `answer` under `key` (a newer answer of the same key takes its
 *  place). Awaited by the gateway before it returns the answer. */
export async function keepAnswer(kind: AnswerKind, key: string, answer: unknown): Promise<void> {
  if (!scopes.getStore()) return;
  try {
    await systemDb
      .insert(aiAnswerCache)
      .values({ key, kind, answer })
      .onConflictDoUpdate({
        target: aiAnswerCache.key,
        set: { answer, createdAt: sql`now()` },
      });
  } catch (err) {
    warnOnce(err);
  }
}

let warned = false;
function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    `[answer-cache] the answer cache could not be used (a try again may pay again): ${errorMessage(err)}`,
  );
}

/** The key of nodes.data a person's read again stamps: when it was asked
 *  (ms since the epoch, the database's clock, as `created_at`). */
const READ_AGAIN_KEY = 'read_again';

/** The stamp of a person's read again, as a jsonb object to merge into
 *  nodes.data (file_reindex). */
export function readAgainStampSql(): SQL {
  return sql`jsonb_build_object(${READ_AGAIN_KEY}::text, floor(extract(epoch from now()) * 1000)::bigint)`;
}

/** When a person last asked to read the item again (its stamp), or null. */
export function readAgainOf(data: unknown): Date | null {
  const at = (data as Record<string, unknown> | null | undefined)?.[READ_AGAIN_KEY];
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? new Date(at) : null;
}
