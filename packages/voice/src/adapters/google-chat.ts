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
} from './types';
import type { DiscoveryResult } from '../discover';
import { GOOGLE_BASE_URL, GOOGLE_CHAT_MODELS } from '../catalogs/google';

type GeminiPart = { text: string };
type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
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

/**
 * Translate OpenAI-shaped messages into Gemini's `contents` array
 * plus a separate `systemInstruction`. Drops any non-text content
 * (Mantle's ChatOptions is text-only today; vision arrives later).
 */
function splitSystemAndContents(
  messages: ChatOptions['messages'],
): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const sys: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      sys.push(m.content);
    } else {
      contents.push({
        // Gemini calls the assistant role 'model'. Anything other than
        // user/assistant is treated as user — defensive default.
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }
  }
  return {
    ...(sys.length > 0 ? { systemInstruction: { parts: [{ text: sys.join('\n\n') }] } } : {}),
    contents,
  };
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

  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
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
    throw new Error(`google chat ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const parsed = (await res.json()) as GeminiResponse;
  // Response shape: candidates[0].content.parts[].text. Concatenate
  // all text parts in case the model returned multi-part output.
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text).filter(Boolean).join('');
  return {
    text: text.trim(),
    model: parsed.modelVersion || opts.model,
    tokensIn: parsed.usageMetadata?.promptTokenCount,
    tokensOut: parsed.usageMetadata?.candidatesTokenCount,
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
