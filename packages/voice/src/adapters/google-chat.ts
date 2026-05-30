/**
 * Google (Gemini) chat adapter.
 *
 * Translates between Mantle's OpenAI-compat messages array and
 * Gemini's `generateContent` shape. Key differences the adapter
 * hides from callers:
 *
 *   1. Messages → `contents` array with `parts: [{ text }]`.
 *   2. Roles: 'user' → 'user', 'assistant' → 'model' (NOT 'assistant').
 *   3. System messages aren't a role — they live in a separate
 *      top-level `systemInstruction` field.
 *   4. Generation config (temperature, maxOutputTokens, topP) lives
 *      under a nested `generationConfig` object, not at the top level.
 *
 * Auth: `x-goog-api-key` header. Endpoint embeds the model in the
 * URL path: POST /v1beta/models/{model}:generateContent.
 *
 * Models API: GET /v1beta/models?key=<apiKey> returns the live list
 * including preview models the key has access to.
 */

import type {
  ChatDispatcher,
  ChatModelInfo,
  ChatOptions,
  ChatResult,
  ChatToolCall,
} from './types';
import { ChatHttpError, parseRetryAfterMs } from './retry';
import type { DiscoveryResult } from '../discover';
import { GOOGLE_BASE_URL, GOOGLE_CHAT_MODELS } from '../catalogs/google';

/** A Gemini content part. The runtime emits three kinds:
 *  - text: narrative content
 *  - functionCall: the model's tool-call request (on a model-role content)
 *  - functionResponse: our tool result fed back (on a user-role content) */
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

/** Gemini's tool declaration is a single `functionDeclarations` array
 *  carrying every callable function — different shape from OpenAI's
 *  per-tool wrapping. */
type GeminiToolDeclaration = {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Gemini 2.5+ models do implicit prompt caching automatically.
     *  When the request's prefix matches a previous call's prefix
     *  (within the 1-hour TTL), the cached portion is billed at ~25%
     *  of the fresh-input rate and surfaces here. Explicit cache API
     *  (cachedContents) would also populate this. */
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
};

type GeminiListModelsResponse = {
  models?: Array<{
    name: string; // 'models/gemini-3.1-pro-preview'
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
};

/** Synthetic id Gemini calls don't have natural ids. We mint
 *  `gemini_call_<n>` so the runtime's tool-loop can pair the result. */
function synthCallId(counter: number): string {
  return `gemini_call_${counter}`;
}

/**
 * Translate ChatOptions.messages → Gemini's `contents` + separate
 * `systemInstruction`. Handles four transformations:
 *
 *   1. **System extraction** — `systemInstruction` is its own top-level
 *      field, not part of `contents`.
 *
 *   2. **Role rename** — assistant → 'model' (Gemini's name for the
 *      role) and tool → 'user' (Gemini doesn't have a 'tool' role; tool
 *      results travel as user-role content with a functionResponse part).
 *
 *   3. **Assistant tool calls** → `parts: [functionCall: {name, args}]`.
 *      Anthropic and OpenAI carry an id on each call; Gemini doesn't —
 *      we mint synthetic ids on the way IN (extractGoogleToolCalls)
 *      so the runtime can pair, and discard them on the way OUT
 *      (functionResponse matches purely by name on the wire).
 *
 *   4. **Tool result** (`role:'tool'`) → user-role content with a
 *      functionResponse part. The result's text body becomes
 *      `response.result` (we wrap the string so the JSON parses).
 */
function splitSystemAndContents(
  messages: ChatOptions['messages'],
): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const sys: string[] = [];
  const contents: GeminiContent[] = [];
  // Map runtime tool-call id → tool name so a subsequent tool message
  // (which only carries the id) can resolve back to the name Gemini
  // expects in functionResponse.
  const toolCallNameById = new Map<string, string>();

  for (const m of messages) {
    if (m.role === 'system') {
      // Flatten array-form system content (the responder splits its
      // system into persona + digest blocks for Anthropic-style
      // caching). Gemini does implicit caching server-side based on
      // prefix match, so we lose nothing by joining.
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => p.text).join('\n\n');
      sys.push(content);
      continue;
    }
    if (m.role === 'user') {
      // String content: single text part.
      if (typeof m.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: m.content }] });
        continue;
      }
      // Array content (multimodal): walk parts. text → text part;
      // image_url is best-effort dropped here (Gemini vision uses a
      // different inline_data shape we don't translate yet — the
      // dedicated google-vision adapter is the production path for
      // image understanding). Falling back to text-only keeps the
      // turn structurally valid rather than 400ing on an unknown
      // part shape.
      const parts: GeminiPart[] = [];
      for (const part of m.content) {
        if (part.type === 'text') parts.push({ text: part.text });
      }
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role: 'user', parts });
      continue;
    }
    if (m.role === 'tool') {
      // Gemini's functionResponse needs the original tool name. If the
      // tool-loop is calling us with a paired toolCallId, look it up.
      // Falls back to the id itself when unknown (rare; means a tool
      // message without a matching prior assistant tool_use call).
      const name = toolCallNameById.get(m.toolCallId) ?? m.toolCallId;
      // The response payload is the tool's JSON-serialised return value.
      // Gemini wants a parsed object — wrap the string under a `result`
      // key when the payload isn't a valid JSON object.
      let parsedResponse: Record<string, unknown>;
      try {
        const obj = JSON.parse(m.content);
        parsedResponse =
          obj && typeof obj === 'object' && !Array.isArray(obj)
            ? obj
            : { result: m.content };
      } catch {
        parsedResponse = { result: m.content };
      }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: parsedResponse } }],
      });
      continue;
    }
    // assistant — may have content, toolCalls, or both
    const parts: GeminiPart[] = [];
    if (typeof m.content === 'string' && m.content.length > 0) {
      parts.push({ text: m.content });
    }
    if ('toolCalls' in m && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        let args: Record<string, unknown>;
        try {
          const obj = JSON.parse(tc.function.arguments || '{}');
          args = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.function.name, args } });
        toolCallNameById.set(tc.id, tc.function.name);
      }
    }
    if (parts.length === 0) {
      // Empty assistant turn — Gemini rejects empty parts arrays. Send
      // a single empty-text part to keep the turn structurally valid.
      parts.push({ text: '' });
    }
    contents.push({ role: 'model', parts });
  }
  return {
    ...(sys.length > 0
      ? { systemInstruction: { parts: [{ text: sys.join('\n\n') }] } }
      : {}),
    contents,
  };
}

/** Translate ChatOptions.tools → Gemini's functionDeclarations form. */
function buildGoogleTools(opts: ChatOptions): GeminiToolDeclaration[] | undefined {
  if (!opts.tools || opts.tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    },
  ];
}

/** Walk parts[], surface every functionCall as a normalised ChatToolCall.
 *  Mints synthetic ids since Gemini's functionCall has no id field. */
function extractGoogleToolCalls(
  parts: GeminiPart[] | undefined,
): ChatToolCall[] | undefined {
  if (!parts) return undefined;
  const calls: ChatToolCall[] = [];
  let counter = 0;
  for (const p of parts) {
    if ('functionCall' in p) {
      counter += 1;
      calls.push({
        id: synthCallId(counter),
        type: 'function',
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

async function googleChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('google-chat: apiKey required');
  if (!opts.model) throw new Error('google-chat: model required');

  const { systemInstruction, contents } = splitSystemAndContents(opts.messages);

  // Gemini packs generation knobs into a nested object — temperature,
  // maxOutputTokens (NOTE: not 'max_tokens'), topP all live here.
  const generationConfig: Record<string, unknown> = {};
  if (typeof opts.temperature === 'number') generationConfig.temperature = opts.temperature;
  if (typeof opts.maxTokens === 'number') generationConfig.maxOutputTokens = opts.maxTokens;
  if (typeof opts.topP === 'number') generationConfig.topP = opts.topP;

  const tools = buildGoogleTools(opts);

  // toolConfig.functionCallingConfig.mode:
  //   - 'AUTO' (default) — model decides when to call
  //   - 'NONE' — disables tool calling for this request
  //   - 'ANY' — forces some tool (we don't expose this through the
  //     'auto'/'none' contract). Map our 'auto'/'none' accordingly.
  const toolConfig =
    opts.toolChoice === 'none'
      ? { functionCallingConfig: { mode: 'NONE' as const } }
      : undefined;

  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(opts.extra ?? {}),
  };

  const res = await fetch(
    `${GOOGLE_BASE_URL}/models/${opts.model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': opts.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new ChatHttpError({ provider: 'google', status: res.status, body: errBody, retryAfterMs: parseRetryAfterMs(res.headers) });
  }
  const parsed = (await res.json()) as GeminiResponse;
  // Response shape: candidates[0].content.parts[]. Walk every part:
  // text parts carry narrative; functionCall parts carry tool calls.
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => ('text' in p ? p.text : ''))
    .filter(Boolean)
    .join('');
  const toolCalls = extractGoogleToolCalls(parts);
  return {
    text: text.trim(),
    model: parsed.modelVersion || opts.model,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: parsed.usageMetadata?.promptTokenCount,
    tokensOut: parsed.usageMetadata?.candidatesTokenCount,
    cacheReadTokens: parsed.usageMetadata?.cachedContentTokenCount,
    // Gemini has no cache-write line item — implicit caching is
    // automatic and free to populate; explicit caching has its own
    // pricing line we don't surface today.
  };
}

async function googleDiscover(apiKey: string): Promise<DiscoveryResult<ChatModelInfo>> {
  try {
    // Gemini accepts the key as `x-goog-api-key` OR as a `?key=` query
    // param. We use the header so the URL stays clean in logs.
    const res = await fetch(`${GOOGLE_BASE_URL}/models`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: [...GOOGLE_CHAT_MODELS],
        filtered: false,
        error: `google /v1beta/models ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const parsed = (await res.json()) as GeminiListModelsResponse;
    // Gemini returns model names prefixed with 'models/'. Strip the
    // prefix when intersecting with our catalog ids.
    const ids = new Set(
      (parsed.models ?? [])
        .filter((m) =>
          // Only chat-capable models — Gemini's list includes embeddings,
          // TTS, robotics models we don't want in the chat dropdown.
          (m.supportedGenerationMethods ?? []).includes('generateContent'),
        )
        .map((m) => m.name.replace(/^models\//, '')),
    );
    const available = GOOGLE_CHAT_MODELS.filter((m) => ids.has(m.id));
    return {
      available: available.length > 0 ? available : [...GOOGLE_CHAT_MODELS],
      filtered: available.length > 0,
      error: null,
    };
  } catch (err) {
    return {
      available: [...GOOGLE_CHAT_MODELS],
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const googleChatAdapter: ChatDispatcher = {
  providerId: 'google',
  adapterName: 'google-chat',
  chat: googleChat,
  discoverModels: googleDiscover,
  staticCatalog: () => GOOGLE_CHAT_MODELS,
};
