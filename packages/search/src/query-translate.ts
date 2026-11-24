/**
 * A search query translated into the brain's search languages
 * (search-languages.ts), for the word arm only (keyword-query.ts).
 *
 * The rules (plan page 0a1eab17):
 *  - the Translator worker's model translates (a brain without one: its
 *    summarizer's route, with this prompt, as the `translate` tool does);
 *    one short call per query and language, only when a person or an agent
 *    searches: never a trigger, a timer or a document;
 *  - each answer is kept (`cache` below), so a repeated query costs nothing;
 *  - a time budget (`TRANSLATE_BUDGET_MS`) for the whole search: past it,
 *    or on any error or refusal, the search runs on what has arrived (the
 *    original text at the least), with one warn line. A late answer still
 *    lands in the cache, so the next search has it;
 *  - a query longer than `TRANSLATE_MAX_CHARS` is not translated (a whole
 *    chat message: the vector arm already reads it in any language).
 *
 * The cache lives in this process, bounded (`CACHE_MAX`, oldest out). The
 * brain's `ai_answer_cache` is keyed by the node an answer was paid for
 * (its primary key and a cascading foreign key), and a query has no node:
 * keeping queries there needs a schema change, which this plan rules out.
 * A cold process pays once per distinct query and language.
 */
import { modelPolicyRefusal } from '@mantle/config';
import { resolveDefaultWorker } from '@mantle/api-keys';
import { getChatAdapter, type ProviderCredential } from '@mantle/voice';
import type { AiWorker, TranslatorParams } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';

/** The search's log lines. Made per line, not at import: a test that
 *  fakes @mantle/tracing without `log` can still import this module. */
const warn = (message: string) => log('search').warn(message);

/** The whole search waits at most this long for its translations. */
export const TRANSLATE_BUDGET_MS = 1500;

/** A longer query is not translated. */
export const TRANSLATE_MAX_CHARS = 300;

/** Kept answers, per process. */
const CACHE_MAX = 2000;

/** The answer's length cap, against a model that talks instead of
 *  translating: a translation is never this much longer than its query. */
const answerCap = (query: string) => query.length * 4 + 100;

/** What one call needs: the model route. */
export type TranslateRoute = {
  provider: string;
  model: string;
  credential: ProviderCredential;
  temperature: number;
};

/** One translation call (the model route, the system prompt, the query):
 *  the answer text. Swappable for tests (`setQueryTranslatorForTests`). */
export type TranslateCall = (
  route: TranslateRoute,
  system: string,
  user: string,
) => Promise<string>;

const cache = new Map<string, Promise<string>>();

/** A language as the model reads it: a code by its English name. */
function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return `${name} (${code})`;
  } catch {
    // Not a code Intl knows: as given.
  }
  return code;
}

/** The system prompt for one language (pure). */
export function translatePrompt(code: string): string {
  return (
    `Translate the user's search query into ${languageName(code)}. ` +
    'Answer with the translated query only: no quotes, no notes, no other text. ' +
    'Keep codes, numbers, part numbers and names as they are. ' +
    'If the query is already in that language, answer it unchanged.'
  );
}

/** The model's answer as search text (pure): trimmed, outer quotes off;
 *  empty when it is no translation (nothing, or far longer than the
 *  query). Empty is kept too: a refusal is not asked again. */
export function cleanAnswer(query: string, answer: string): string {
  const t = answer
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  if (!t || t.length > answerCap(query)) return '';
  return t;
}

/** The route: the Translator worker, else the summarizer's; null with the
 *  reason when there is none to use. */
async function translateRoute(
  ownerId: string,
): Promise<{ route: TranslateRoute } | { why: string }> {
  let resolved = await resolveDefaultWorker(ownerId, 'translator');
  let onSummarizer = false;
  if (!resolved.ok && resolved.why === 'none') {
    resolved = await resolveDefaultWorker(ownerId, 'summarizer');
    onSummarizer = true;
  }
  if (!resolved.ok) {
    return {
      why: `no usable ${onSummarizer ? 'translator or summarizer' : 'translator'} worker (${resolved.why})`,
    };
  }
  const worker: AiWorker = resolved.worker;
  const refused = modelPolicyRefusal(worker.provider, worker.model, worker.baseUrl ?? null);
  if (refused) return { why: refused.message };
  // The summarizer's own params are for summaries: none of them here.
  const params = (onSummarizer ? {} : (worker.params ?? {})) as TranslatorParams;
  return {
    route: {
      provider: worker.provider,
      model: worker.model,
      credential: resolved.credential,
      temperature: params.temperature ?? 0.2,
    },
  };
}

/** The real call: one short chat, no retries (the budget is short; a
 *  late answer would only fill the cache). The adapter's own deadline
 *  (PROVIDER_TIMEOUTS.chat) ends a call that hangs. */
const chatCall: TranslateCall = async (route, system, user) => {
  const adapter = getChatAdapter(route.provider);
  if (!adapter) throw new Error(`provider '${route.provider}' cannot run a chat call`);
  const result = await adapter.chat({
    ...route.credential,
    model: route.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: route.temperature,
    maxTokens: 256,
    maxRetries: 0,
  });
  // A cut answer is no translation, kept as a refusal is: a model that
  // spends its tokens before it answers would only be cut again.
  if (result.finishReason === 'length') return '';
  return result.text ?? '';
};

let call: TranslateCall = chatCall;
let routeOf: (ownerId: string) => Promise<{ route: TranslateRoute } | { why: string }> =
  translateRoute;

/** Tests only: swap the call and the route (null puts the real ones back)
 *  and empty the cache. */
export function setQueryTranslatorForTests(
  fake: { call: TranslateCall; route?: TranslateRoute | { why: string } } | null,
): void {
  cache.clear();
  call = fake?.call ?? chatCall;
  const r = fake?.route;
  routeOf = fake
    ? async () =>
        r && 'why' in r
          ? r
          : {
              route: r ?? {
                provider: 'test',
                model: 'test-model',
                credential: { apiKey: 'test' } as ProviderCredential,
                temperature: 0,
              },
            }
    : translateRoute;
}

/** The kept (or running) answer of `key`, or a new call. A failed call is
 *  dropped from the cache (asked again next time); an answer, a refusal's
 *  empty one included, stays. */
function cachedCall(key: string, start: () => Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (hit) {
    // Most recent last: the oldest goes first when full.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = start();
  cache.set(key, p);
  p.catch(() => {
    if (cache.get(key) === p) cache.delete(key);
  });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return p;
}

/** Wait for `p` until `deadline` (ms since the epoch): its value, or
 *  `timeout`. A rejection is `error` with its message. */
async function until(
  p: Promise<string>,
  deadline: number,
): Promise<{ text: string } | { timeout: true } | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<{ timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([
      p.then(
        (text) => ({ text }),
        (err: unknown) => ({ error: errorMessage(err) }),
      ),
      wait,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One translation of a query, with its language. */
export type QueryTranslation = { lang: string; text: string };

/**
 * The query's translations into `languages`, in their order, each one
 * that arrived within the budget and is a translation (not empty, not the
 * query itself). Never throws, never waits past the budget. One warn line
 * when any language is left out.
 */
export async function translateQuery(
  ownerId: string,
  query: string,
  languages: readonly string[],
  opts: { budgetMs?: number } = {},
): Promise<QueryTranslation[]> {
  const text = query.trim();
  if (languages.length === 0 || !text) return [];
  if (text.length > TRANSLATE_MAX_CHARS) return [];
  const deadline = Date.now() + (opts.budgetMs ?? TRANSLATE_BUDGET_MS);
  const missed: string[] = [];
  try {
    // Only a language not yet kept needs the route (its key read).
    const keyOf = (lang: string) => `${lang}\u0000${text}`;
    let route: Promise<{ route: TranslateRoute } | { why: string }> | null = null;
    const answers = await Promise.all(
      languages.map(async (lang) => {
        let asked = false;
        const p = cachedCall(keyOf(lang), async () => {
          asked = true;
          route ??= routeOf(ownerId);
          const r = await route;
          if ('why' in r) throw new Error(r.why);
          return cleanAnswer(text, await call(r.route, translatePrompt(lang), text));
        });
        const got = await until(p, deadline);
        if ('text' in got) {
          // Said once, when the model was asked: a kept empty answer is quiet.
          if (!got.text && asked) {
            missed.push(
              `${lang}: no translation in the answer (a refusal, or cut at its length limit)`,
            );
          }
          return got.text;
        }
        missed.push(`${lang}: ${'timeout' in got ? 'past the time budget' : got.error}`);
        return '';
      }),
    );
    const out = answers
      .map((a, i) => ({ lang: languages[i]!, text: a }))
      .filter((a) => a.text && a.text.toLowerCase() !== text.toLowerCase());
    if (missed.length) {
      warn(
        `translated terms left out (${missed.join('; ')}): the word search ran on the rest`,
      );
    }
    return out;
  } catch (err) {
    warn(
      `query not translated (${errorMessage(err)}): the word search ran on the original text`,
    );
    return [];
  }
}
