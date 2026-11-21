/**
 * The answer cache (migration 0392; docs/provider-http.md, "Kept answers";
 * owner decision 2026-11-20). One rule: every paid AI answer of queue work is
 * kept before anything after it can wait, so a try again never pays for it
 * twice. A provider's "not now" is then only a wait: the job is sent again
 * with its growing gap, and nothing is counted.
 *
 * The worker gateway keeps and takes the answers (runVisionWorker and
 * runScanReader in @mantle/runtime, the extractor's call in server/api
 * extract/model.ts), keyed by the node in scope and sha256 of what was
 * asked: the kind, the provider and model, the prompt, and the input (its
 * bytes' hash, or a name the caller gives when the bytes of one input may
 * differ between reads, as a scanned page cut again). Per node: a try again
 * of that node never pays twice, another node with the same bytes pays once
 * for its own, and a node's answers go with it (the cascade of 0392).
 *
 * Only inside withAnswerCache with a node: the extract queue runs each job
 * in it. Outside (a chat turn, a test), or with no node, nothing is read or
 * written. Every paid answer is kept, with whether the caller accepted it
 * (could use it). One not accepted is taken only by a wait's try again, and
 * only when its own chain kept it: kept at or after `from`, when the chain's
 * first try began (the database's clock, which the wait carries), so that
 * try does what the first did without paying again. A fresh job (a person's
 * new run or read again) asks again, and its answer takes the row; and a
 * new chain's try again never takes what an older job kept and could not
 * use. A person's read again
 * (file_reindex) stamps the node (readAgainStampSql); its extract then takes
 * only answers kept after that moment (`since`), so it pays once for the read
 * the person asked for, and its own tries again after a wait still pay
 * nothing twice.
 *
 * A failed read is no answer (the call is made); a failed write is logged,
 * each one, and the answer in hand is used. Never throws. A keep that
 * failed is marked on the scope (answerKeepFailed): the extract queue then
 * sends no wait, a read takes pg-boss's bounded retries (an Agent's run,
 * with none, fails once), so a cache that cannot keep never turns waits
 * into an endless paid loop.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { and, eq, gte, or, sql, type SQL } from 'drizzle-orm';
import { errorMessage } from '@mantle/std';
import { systemDb } from './gateway/handles';
import { aiAnswerCache } from './schema/ai-answer-cache';

/** The kinds of answer kept. `decider`: the page ask of the PDF router's
 *  page types (server/api extract/pdf-kind.ts). */
export type AnswerKind = 'vision' | 'scan_reader' | 'extractor' | 'decider';

/** A surrogate with no pair (a cut inside a pair, a provider's bad bytes). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** A scope: its node, its read again, for a wait's try again when its
 *  chain's first try began, and whether a keep failed in it or in the scope
 *  it runs in (one mark for the whole job). */
type Scope = {
  since: Date | null;
  nodeId: string | null;
  from: Date | null;
  failed: { keep: boolean };
};

const scopes = new AsyncLocalStorage<Scope>();

/**
 * Run `fn` with the answer cache on for the node `nodeId` (null: off).
 * `since`: only answers kept at or after it are taken (a person's read
 * again); null, any. `from`: a wait's try again, when its chain's first
 * try began; it takes an answer not accepted too when it was kept at or
 * after that (default: the scope it runs in, else none: accepted only).
 */
export function withAnswerCache<T>(
  fn: () => Promise<T>,
  since: Date | null,
  nodeId: string | null,
  opts: { from?: Date | null } = {},
): Promise<T> {
  const outer = scopes.getStore();
  const failed = outer?.failed ?? { keep: false };
  const from = opts.from !== undefined ? opts.from : (outer?.from ?? null);
  return scopes.run({ since, nodeId, from, failed }, fn);
}

/** A read of the cache on the system pool. A failed read is null, logged,
 *  and never thrown: no answer (the call is made), or no clock. */
async function cacheRead<T>(
  what: string,
  read: (db: typeof systemDb) => Promise<T | null>,
): Promise<T | null> {
  try {
    return await read(systemDb);
  } catch (err) {
    console.error(`[answer-cache] ${what} could not be read: ${errorMessage(err)}`);
    return null;
  }
}

/** Now, by the database's clock (as `created_at` and the read again stamp):
 *  when a job's first try begins, so a wait can carry it (`from`). Null when
 *  it cannot be read: the try again then takes accepted answers only. */
export function answerCacheNow(): Promise<Date | null> {
  return cacheRead('the database clock', async (db) => {
    const rows = (await db.execute(
      sql`select floor(extract(epoch from now()) * 1000)::bigint as ms`,
    )) as unknown as Array<{ ms: number | string }>;
    const ms = Number(rows[0]?.ms);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
  });
}

/** Whether a paid answer could not be kept in this scope: a try again
 *  would pay for it again, so a wait must not be sent as a wait. */
export function answerKeepFailed(): boolean {
  return scopes.getStore()?.failed.keep === true;
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

/** The kept answer of `key`, or null: none, too old for this read, not
 *  accepted and not kept by this wait's own chain, no cache here, or the
 *  read failed. */
export async function keptAnswer<T>(key: string): Promise<T | null> {
  const scope = scopes.getStore();
  const nodeId = scope?.nodeId;
  if (!scope || !nodeId) return null;
  return cacheRead('a kept answer', async (db) => {
    const [row] = await db
      .select({ answer: aiAnswerCache.answer })
      .from(aiAnswerCache)
      .where(
        and(
          eq(aiAnswerCache.nodeId, nodeId),
          eq(aiAnswerCache.key, key),
          scope.since ? gte(aiAnswerCache.createdAt, scope.since) : undefined,
          scope.from
            ? or(eq(aiAnswerCache.accepted, true), gte(aiAnswerCache.createdAt, scope.from))
            : eq(aiAnswerCache.accepted, true),
        ),
      )
      .limit(1);
    return (row?.answer as T | undefined) ?? null;
  });
}

/** Keep `answer` under `key` (a newer answer of the same key takes its
 *  place), with whether the caller accepted it. Awaited by the gateway
 *  before it returns the answer. */
export async function keepAnswer(
  kind: AnswerKind,
  key: string,
  answer: unknown,
  accepted: boolean,
): Promise<void> {
  const scope = scopes.getStore();
  const nodeId = scope?.nodeId;
  if (!scope || !nodeId) return;
  try {
    // Well-formed strings: jsonb refuses a NUL and a lone surrogate.
    const kept: unknown = JSON.parse(
      JSON.stringify(answer, (_k, v: unknown) =>
        typeof v === 'string'
          ? v.split(String.fromCharCode(0)).join('').replace(LONE_SURROGATE, '\uFFFD')
          : v,
      ),
    );
    await systemDb
      .insert(aiAnswerCache)
      .values({ nodeId, key, kind, answer: kept, accepted })
      .onConflictDoUpdate({
        target: [aiAnswerCache.nodeId, aiAnswerCache.key],
        set: { answer: kept, accepted, createdAt: sql`now()` },
      });
  } catch (err) {
    scope.failed.keep = true;
    console.error(
      `[answer-cache] a paid ${kind} answer was not kept (a wait takes the retries): ${errorMessage(err)}`,
    );
  }
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
