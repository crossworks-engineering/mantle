/**
 * Microsoft Foundry chat adapter (Azure AI Foundry, Azure OpenAI).
 *
 * The v1 API is the OpenAI chat completions wire shape at
 * `<resource>/openai/v1/chat/completions`, so message and tool translation
 * and the streamer are the shared openai-compat ones (xAI, DeepSeek,
 * Mammouth and custom use the same). docs/foundry.md has the API as checked
 * on Microsoft Learn. The Foundry parts:
 *
 *   - Endpoint. The route's Base URL, else MANTLE_FOUNDRY_ENDPOINT, reduced
 *     to the resource root (foundryResourceRoot). MANTLE_FOUNDRY_API_VERSION
 *     picks the v1 route (unset, `v1`, `preview`) or the older
 *     per-deployment route (a date version).
 *   - Model id = DEPLOYMENT name. Sent as `model` on v1, in the path on the
 *     dated route.
 *   - Auth. The key goes in the `api-key` header, nothing else. Key from the
 *     vault (service `foundry`), or MANTLE_FOUNDRY_API_KEY through
 *     `envCredential` for a route with no Base URL of its own.
 *   - Reasoning models refuse `max_tokens` and sampling parameters. Thinking
 *     on: `reasoning_effort` + `max_completion_tokens`, no sampling. Thinking
 *     off: `max_tokens`. A 400 that names a refused parameter gets a resend
 *     with that one fix (`paramFix`: each kind once, three at most). A 400
 *     comes before any stream output, so a resend never repeats text.
 *   - Errors are the shared ChatHttpError: retry (429 with `retry-after-ms`,
 *     5xx), failover, and the provider_alerts circuit read the status the
 *     same way for every provider. A 404 (no such deployment) is not
 *     retried. Config problems throw a fixed sentence that never echoes the
 *     endpoint or the key.
 *   - Cost: none on the answer; the spend recorder's fallback table applies.
 */

import type {
  ChatDispatcher,
  ChatModelInfo,
  ChatOptions,
  ChatResult,
  ChatStreamSink,
  ProviderCredential,
} from './types';
import { ChatHttpError, parseRetryAfterMs } from './retry';
import type { DiscoveryResult } from '../discover';
import {
  FOUNDRY_API_VERSION_INVALID,
  FOUNDRY_CHAT_MODELS,
  FOUNDRY_ENDPOINT_INVALID,
  FOUNDRY_ENDPOINT_PROBLEM,
  foundryChatUrl,
  foundryModelsUrl,
  foundryResourceRoot,
  parseFoundryApiVersion,
  type FoundryApiVersion,
} from '../catalogs/foundry';
import {
  extractOpenAICompatToolCalls,
  mapOpenAICompatFinishReason,
  streamOpenAICompatChat,
  toOpenAICompatMessages,
  type OpenAICompatChatResponse,
} from './openai-compat';
import { customReasoningEffort, sanitizeForReasoning } from './custom-chat';
import { scrubThinkBlocks } from './think-scrubber';
import { env } from '@mantle/config';
import { PROVIDER_TIMEOUTS } from '@mantle/std';
import { providerFetch, type ProviderFetchOptions } from './provider-fetch';
import { tailnetFetch } from './tailnet';

const PROVIDER = 'foundry';

/** Where a call goes: the resource root and the API version. */
type FoundryTarget = { root: string; version: FoundryApiVersion };

/**
 * The endpoint and API version for a call. Throws a fixed sentence (never
 * the value) when the endpoint is missing or not a plain https URL, or the
 * API version is not one we know.
 */
export function foundryTarget(baseUrl: string | null | undefined): FoundryTarget {
  const endpoint = baseUrl?.trim() || env('MANTLE_FOUNDRY_ENDPOINT')?.trim() || '';
  if (!endpoint) throw new Error(`foundry-chat: ${FOUNDRY_ENDPOINT_PROBLEM}`);
  const root = foundryResourceRoot(endpoint);
  if (!root) throw new Error(`foundry-chat: ${FOUNDRY_ENDPOINT_INVALID}`);
  const version = parseFoundryApiVersion(env('MANTLE_FOUNDRY_API_VERSION'));
  if (!version) throw new Error(`foundry-chat: ${FOUNDRY_API_VERSION_INVALID}`);
  return { root, version };
}

/**
 * providerFetch with redirects refused. The key rides a custom `api-key`
 * header, which a redirect to another origin would carry along (only
 * `Authorization` and cookies are dropped), with the prompt on a 307 or 308.
 * Foundry answers in place, so a redirect is never one to follow.
 */
function foundryFetch(
  url: string | URL | Request,
  init?: RequestInit,
  opts?: ProviderFetchOptions,
): Promise<Response> {
  return providerFetch(url, { ...init, redirect: 'error' }, opts);
}

/** The same through the Tailscale proxy, for a route flagged `viaTailnet`
 *  (a gateway in front of the resource reachable only on the tailnet). */
function foundryTailnetFetch(
  url: string,
  init?: RequestInit,
  opts?: ProviderFetchOptions,
): Promise<Response> {
  return tailnetFetch(url, { ...init, redirect: 'error' }, opts);
}

/** The fetch for a call's route. */
function fetchFor(opts: ChatOptions) {
  return opts.viaTailnet ? foundryTailnetFetch : foundryFetch;
}

function headers(apiKey: string): Record<string, string> {
  return { 'api-key': apiKey, 'content-type': 'application/json' };
}

/** One request's parameters: the options for the shared body builder, the
 *  extra body fields, and the parameter fixes already made (each is made
 *  once, so two fixes can never undo each other). */
type FoundryRequest = {
  o: ChatOptions;
  extra: Record<string, unknown>;
  done: ReadonlySet<FixKind>;
};

type FixKind = 'effort' | 'to_completion' | 'to_tokens' | 'sampling';

/** The request as Foundry wants it: thinking on moves the output budget to
 *  `max_completion_tokens` (reasoning models refuse `max_tokens`) and drops
 *  the sampling parameters. */
function prepare(opts: ChatOptions): FoundryRequest {
  const effort = customReasoningEffort(opts);
  if (!effort) return { o: opts, extra: {}, done: new Set() };
  const { maxTokens, ...rest } = sanitizeForReasoning(opts, true);
  return {
    o: rest,
    extra: {
      reasoning_effort: effort,
      ...(typeof maxTokens === 'number' ? { max_completion_tokens: maxTokens } : {}),
    },
    done: new Set(),
  };
}

/** Words a 400 uses for a parameter the model does not take. */
const UNSUPPORTED_RE =
  /unsupported|not supported|does not support|is not allowed|not permitted|unrecognized|unknown parameter|only the default/i;

/** The most fixes one call makes (one of each kind but the two that undo
 *  each other's budget move). */
const MAX_FIXES = 3;

/**
 * The fixed request after a 400 that names a parameter this deployment
 * refuses, or null. Each kind is made at most once, and only when it
 * changes what was sent:
 *   - `reasoning_effort` refused (a non-reasoning model with thinking on):
 *     send none, and the budget as `max_tokens` again.
 *   - `max_tokens` refused (a reasoning model, thinking off): move the
 *     budget to `max_completion_tokens`, with `reasoning_effort: low` so the
 *     model's default reasoning does not eat the whole budget.
 *   - `max_completion_tokens` refused (a model that only takes
 *     `max_tokens`): move the budget back.
 *   - `temperature` or `top_p` refused: send neither.
 * Exported for the tests.
 */
export function paramFix(err: unknown, req: FoundryRequest): FoundryRequest | null {
  if (!(err instanceof ChatHttpError) || err.status !== 400) return null;
  const text = err.body ?? '';
  const { o, extra, done } = req;
  const made = (kind: FixKind, next: Omit<FoundryRequest, 'done'>): FoundryRequest => ({
    ...next,
    done: new Set([...done, kind]),
  });
  const refused = UNSUPPORTED_RE.test(text);

  if (
    !done.has('effort') &&
    'reasoning_effort' in extra &&
    refused &&
    /reasoning_effort/.test(text)
  ) {
    const { reasoning_effort: _r, ...rest } = extra;
    // Our own `low` from the max_tokens swap: the model wants
    // max_completion_tokens, so the budget stays there.
    if (done.has('to_completion')) return made('effort', { o, extra: rest });
    const { max_completion_tokens: mct, ...noBudget } = rest;
    return made('effort', {
      o: typeof mct === 'number' ? { ...o, maxTokens: mct } : o,
      extra: noBudget,
    });
  }
  if (
    !done.has('to_completion') &&
    !done.has('to_tokens') &&
    typeof o.maxTokens === 'number' &&
    refused &&
    /max_completion_tokens/.test(text)
  ) {
    const { maxTokens, ...rest } = o;
    return made('to_completion', {
      o: rest,
      extra: {
        ...extra,
        max_completion_tokens: maxTokens,
        ...(done.has('effort') || 'reasoning_effort' in extra ? {} : { reasoning_effort: 'low' }),
      },
    });
  }
  if (
    !done.has('to_tokens') &&
    !done.has('to_completion') &&
    typeof extra.max_completion_tokens === 'number' &&
    refused &&
    /max_completion_tokens/.test(text) &&
    !/\bmax_tokens\b/.test(text)
  ) {
    const { max_completion_tokens: mct, ...rest } = extra;
    return made('to_tokens', { o: { ...o, maxTokens: mct as number }, extra: rest });
  }
  if (
    !done.has('sampling') &&
    refused &&
    /\b(?:temperature|top_p)\b/.test(text) &&
    (typeof o.temperature === 'number' || typeof o.topP === 'number')
  ) {
    const { temperature: _t, topP: _p, ...rest } = o;
    return made('sampling', { o: rest, extra });
  }
  return null;
}

/** Run `call`, and again after each parameter fix a 400 asks for. */
async function withParamFix<T>(
  start: FoundryRequest,
  call: (o: ChatOptions, extra: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  let cur = start;
  for (let fixes = 0; ; fixes++) {
    try {
      return await call(cur.o, cur.extra);
    } catch (err) {
      const next = fixes < MAX_FIXES && !cur.o.signal?.aborted ? paramFix(err, cur) : null;
      if (!next) throw err;
      cur = next;
    }
  }
}

function requireArgs(opts: ChatOptions): void {
  if (!opts.apiKey) throw new Error('foundry-chat: apiKey required');
  if (!opts.model?.trim()) throw new Error('foundry-chat: model (the deployment name) required');
}

async function foundryChat(opts: ChatOptions): Promise<ChatResult> {
  requireArgs(opts);
  const target = foundryTarget(opts.baseUrl);
  const url = foundryChatUrl(target.root, opts.model, target.version);
  return withParamFix(prepare(opts), async (o, extra) => {
    const tools = o.tools && o.tools.length > 0 ? o.tools : undefined;
    const body: Record<string, unknown> = {
      model: o.model,
      messages: toOpenAICompatMessages(o.messages),
      ...(tools ? { tools } : {}),
      ...(o.toolChoice && tools ? { tool_choice: o.toolChoice } : {}),
      ...(typeof o.temperature === 'number' ? { temperature: o.temperature } : {}),
      ...(typeof o.maxTokens === 'number' ? { max_tokens: o.maxTokens } : {}),
      ...(typeof o.topP === 'number' ? { top_p: o.topP } : {}),
      ...extra,
      ...(o.extra ?? {}),
    };
    const res = await fetchFor(opts)(
      url,
      {
        method: 'POST',
        headers: headers(opts.apiKey),
        body: JSON.stringify(body),
        signal: o.signal,
      },
      { timeoutMs: PROVIDER_TIMEOUTS.chatRelay },
    );
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new ChatHttpError({
        provider: PROVIDER,
        status: res.status,
        body: errBody,
        retryAfterMs: parseRetryAfterMs(res.headers),
      });
    }
    const parsed = (await res.json()) as OpenAICompatChatResponse & { model?: string };
    const message = parsed.choices?.[0]?.message;
    const text = scrubThinkBlocks(message?.content ?? '');
    const toolCalls = extractOpenAICompatToolCalls(message);
    const finishReason = mapOpenAICompatFinishReason(parsed.choices?.[0]?.finish_reason);
    return {
      text: text.trim(),
      model: parsed.model || o.model,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
      tokensIn: parsed.usage?.prompt_tokens,
      tokensOut: parsed.usage?.completion_tokens,
      cacheReadTokens: parsed.usage?.prompt_tokens_details?.cached_tokens,
    };
  });
}

/** Streaming chat: the shared OpenAI-compat streamer (it skips Foundry's
 *  first chunk, which has empty `choices` and only filter results). */
async function foundryChatStream(opts: ChatOptions, onDelta: ChatStreamSink): Promise<ChatResult> {
  requireArgs(opts);
  const target = foundryTarget(opts.baseUrl);
  const url = foundryChatUrl(target.root, opts.model, target.version);
  return withParamFix(prepare(opts), (o, extra) =>
    streamOpenAICompatChat(
      o,
      {
        url,
        headers: headers(opts.apiKey),
        provider: PROVIDER,
        bodyExtra: extra,
        fetchImpl: fetchFor(opts),
      },
      onDelta,
    ),
  );
}

/** A failed model list, in fixed words by status (never the body). */
function discoverProblem(status: number): string {
  if (status === 401 || status === 403) {
    return `Microsoft Foundry refused the key (HTTP ${status}). Use a key from this resource's Keys and Endpoint page, and check MANTLE_FOUNDRY_ENDPOINT names the same resource.`;
  }
  if (status === 404) {
    return 'Microsoft Foundry has no model list at this endpoint (HTTP 404). Check MANTLE_FOUNDRY_ENDPOINT is the resource URL.';
  }
  return `Microsoft Foundry answered the model list with HTTP ${status}.`;
}

/**
 * The key test and the model dropdown. Foundry lists the BASE MODELS a
 * resource can use, not its deployments, so the answer is the seed plus the
 * listed ids as hints, and a 200 proves the key. No `liveIds`: deployments
 * are named by the owner, so the list is no catalogue to drift from.
 * Discovery has no route, so it reads the environment's endpoint only.
 */
async function foundryDiscover({
  apiKey,
}: ProviderCredential): Promise<DiscoveryResult<ChatModelInfo>> {
  const seed = [...FOUNDRY_CHAT_MODELS];
  let target: FoundryTarget;
  try {
    target = foundryTarget(null);
  } catch (err) {
    const msg = err instanceof Error ? err.message.replace(/^foundry-chat: /, '') : '';
    return { available: seed, filtered: false, error: msg };
  }
  try {
    const res = await foundryFetch(
      foundryModelsUrl(target.root, target.version),
      { headers: { 'api-key': apiKey } },
      { timeoutMs: PROVIDER_TIMEOUTS.discover },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { available: seed, filtered: false, error: discoverProblem(res.status) };
    }
    const parsed = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const known = new Set(seed.map((m) => m.id.toLowerCase()));
    const extra: ChatModelInfo[] = [];
    for (const m of parsed.data ?? []) {
      if (typeof m.id !== 'string' || !m.id || known.has(m.id.toLowerCase())) continue;
      if (/embedding|whisper|tts|dall-e|image|sora|transcribe|realtime/i.test(m.id)) continue;
      known.add(m.id.toLowerCase());
      extra.push({
        id: m.id,
        label: m.id,
        description:
          'A model this resource can deploy. Use it here only if a deployment has this name; otherwise type the deployment name.',
      });
    }
    return { available: [...seed, ...extra], filtered: true, error: null };
  } catch {
    return {
      available: seed,
      filtered: false,
      error: 'Microsoft Foundry did not answer the model list (network or timeout).',
    };
  }
}

/** MANTLE_FOUNDRY_API_KEY for a route with no Base URL of its own, so the
 *  box-level key only goes to MANTLE_FOUNDRY_ENDPOINT. Null otherwise. */
function foundryEnvCredential(baseUrl: string | null): ProviderCredential | null {
  if (baseUrl?.trim()) return null;
  const apiKey = env('MANTLE_FOUNDRY_API_KEY')?.trim();
  if (!apiKey || !env('MANTLE_FOUNDRY_ENDPOINT')?.trim()) return null;
  return { apiKey };
}

export const foundryChatAdapter: ChatDispatcher = {
  providerId: 'foundry',
  adapterName: 'foundry-chat',
  chat: foundryChat,
  chatStream: foundryChatStream,
  discoverModels: foundryDiscover,
  staticCatalog: () => FOUNDRY_CHAT_MODELS,
  envCredential: foundryEnvCredential,
};
