/**
 * OpenRouter vision adapter — image OCR (`extract`) AND native PDF
 * (`extractDocument`) through OpenRouter's OpenAI-compatible chat endpoint.
 *
 * Why this matters: with only an OpenRouter key, the whole text+vision brain
 * is functional — chat (responder/extractor/summarizer/reflector), embeddings,
 * and now image + document extraction all route through OR. (TTS/STT/image-gen
 * still need a direct provider — OR doesn't proxy audio or image generation.)
 *
 * - `extract(image)`: a single user turn with an `image_url` content block,
 *   exactly like the chat adapter's vision turns.
 * - `extractDocument(pdf)`: a `file` content block + OR's `file-parser` plugin
 *   with `engine: 'native'`, so OR hands the PDF to a model that reads it
 *   natively (Claude/Gemini). Non-native models error → the caller rasterizes.
 *
 * Raw fetch (not the SDK) so we control the multimodal content shape directly;
 * mirrors the openai-compat dialect OR speaks. Auth + attribution headers match
 * openrouter-chat so OR's dashboard sees one fingerprint.
 */

import type {
  VisionDispatcher,
  VisionExtractOptions,
  VisionExtractResult,
  VisionModelInfo,
  ProviderCredential,
} from './types';
import type { DiscoveryResult } from '../discover';
import { OPENROUTER_BASE_URL, OPENROUTER_VISION_MODELS } from '../catalogs/openrouter';
import { errorMessage, PROVIDER_TIMEOUTS, ProviderHttpError } from '@mantle/std';
import { providerFetch } from './provider-fetch';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

type OrChatResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://mantle-ai.tech',
    'X-Title': 'Mantle',
    'Content-Type': 'application/json',
  };
}

/** message.content can be a string or an array of blocks — concatenate text. */
function replyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c &&
        typeof c === 'object' &&
        'text' in c &&
        typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

async function post(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<VisionExtractResult & { _model: string; finishReason?: string }> {
  const res = await providerFetch(
    `${OPENROUTER_BASE_URL}/chat/completions`,
    {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(body),
    },
    { timeoutMs },
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new ProviderHttpError({
      provider: 'openrouter',
      status: res.status,
      body: errBody,
      message: `openrouter-vision ${res.status}: ${errBody.slice(0, 400)}`,
    });
  }
  const parsed = (await res.json()) as OrChatResponse;
  const text = replyText(parsed.choices?.[0]?.message?.content).trim();
  const model = parsed.model || String(body.model);
  const finish = parsed.choices?.[0]?.finish_reason;
  return {
    text,
    model,
    tokensIn: parsed.usage?.prompt_tokens,
    tokensOut: parsed.usage?.completion_tokens,
    _model: model,
    ...(typeof finish === 'string' && finish ? { finishReason: finish } : {}),
  };
}

type OrListModelsResponse = {
  data?: Array<{
    id: string;
    name?: string;
    description?: string;
    context_length?: number;
    top_provider?: { context_length?: number };
    pricing?: { prompt?: string; completion?: string };
    architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  }>;
};

function perMillion(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 1_000_000 * 10_000) / 10_000 : undefined;
}

/**
 * An image READER accepts pictures and answers in TEXT. Filtering on image
 * INPUT alone (what this did until 2026-09-02) also matched every image
 * GENERATOR — Nano Banana Pro, GPT Image and friends all take an image in —
 * so the vision dropdown offered generators, which bill image-generation
 * tokens and return a picture this adapter's text parser reads as empty.
 * The output side is the decider; routers (`openrouter/auto`) advertise the
 * union of everything they might route to, so they are excluded too.
 */
function isImageReader(
  arch: { input_modalities?: string[]; output_modalities?: string[] } | undefined,
): boolean {
  const inputs = arch?.input_modalities ?? [];
  const outputs = arch?.output_modalities ?? [];
  if (!inputs.includes('image')) return false;
  if (outputs.length === 0) return true; // no output info — trust the input side
  return outputs.includes('text') && !outputs.includes('image');
}

/** What a several-image request may add: a cap on the model's reasoning
 *  tokens (OpenRouter's `reasoning.max_tokens`, so a thinking model leaves
 *  room in `maxTokens` for the answer itself). */
export type ImagesRequestExtra = { reasoningMaxTokens?: number };

/** A several-image reply, with why the model stopped (`length`: cut off at
 *  the token cap) when the provider says. */
export type ImagesResult = VisionExtractResult & { finishReason?: string };

/**
 * Several images in ONE request: a text block, then each image after its
 * own short caption ("Image 3: ..."), so the model can answer per image.
 * Used through `extractImages` (./vision-images.ts), which records spend.
 */
export async function openrouterExtractImages(
  images: readonly { bytes: Buffer; mimeType: string; caption?: string }[],
  opts: VisionExtractOptions,
  extra: ImagesRequestExtra = {},
): Promise<ImagesResult> {
  if (!opts.apiKey) throw new Error('openrouter-vision: apiKey required');
  if (!images.length || images.some((i) => !i.bytes?.length)) {
    throw new Error('openrouter-vision: an empty image buffer');
  }
  const model = opts.model || DEFAULT_MODEL;
  const content: Record<string, unknown>[] = [{ type: 'text', text: opts.prompt }];
  for (const img of images) {
    if (img.caption) content.push({ type: 'text', text: img.caption });
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.bytes.toString('base64')}` },
    });
  }
  const r = await post(
    opts.apiKey,
    {
      model,
      max_tokens: opts.maxTokens ?? 2000,
      ...(extra.reasoningMaxTokens ? { reasoning: { max_tokens: extra.reasoningMaxTokens } } : {}),
      messages: [
        ...(opts.systemPrompt?.trim() ? [{ role: 'system', content: opts.systemPrompt }] : []),
        { role: 'user', content },
      ],
    },
    PROVIDER_TIMEOUTS.visionImages,
  );
  return {
    text: r.text,
    model: r.model,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    ...(r.finishReason ? { finishReason: r.finishReason } : {}),
  };
}

export const openrouterVisionAdapter: VisionDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-vision',

  async extract(image: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult> {
    if (!opts.apiKey) throw new Error('openrouter-vision: apiKey required');
    if (!image || image.length === 0) throw new Error('openrouter-vision: empty image buffer');
    const model = opts.model || DEFAULT_MODEL;
    const dataUrl = `data:${opts.mimeType || 'image/jpeg'};base64,${image.toString('base64')}`;
    const r = await post(
      opts.apiKey,
      {
        model,
        max_tokens: opts.maxTokens ?? 2000,
        messages: [
          ...(opts.systemPrompt?.trim() ? [{ role: 'system', content: opts.systemPrompt }] : []),
          {
            role: 'user',
            content: [
              { type: 'text', text: opts.prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      },
      PROVIDER_TIMEOUTS.vision,
    );
    return { text: r.text, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  },

  async extractDocument(pdf: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult> {
    if (!opts.apiKey) throw new Error('openrouter-vision: apiKey required');
    if (!pdf || pdf.length === 0) throw new Error('openrouter-vision: empty PDF buffer');
    const model = opts.model || DEFAULT_MODEL;
    const dataUrl = `data:application/pdf;base64,${pdf.toString('base64')}`;
    const r = await post(
      opts.apiKey,
      {
        model,
        max_tokens: opts.maxTokens ?? 8000,
        // OR's file-parser plugin: 'native' hands the PDF to the model's own
        // PDF reader (Claude/Gemini). Non-native models error → caller falls
        // back to rasterize → image OCR.
        plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }],
        messages: [
          ...(opts.systemPrompt?.trim() ? [{ role: 'system', content: opts.systemPrompt }] : []),
          {
            role: 'user',
            content: [
              { type: 'text', text: opts.prompt },
              { type: 'file', file: { filename: 'document.pdf', file_data: dataUrl } },
            ],
          },
        ],
      },
      PROVIDER_TIMEOUTS.visionDocument,
    );
    return { text: r.text, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  },

  async discoverModels({ apiKey }: ProviderCredential): Promise<DiscoveryResult<VisionModelInfo>> {
    try {
      const res = await providerFetch(
        `${OPENROUTER_BASE_URL}/models`,
        {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        },
        { timeoutMs: PROVIDER_TIMEOUTS.discover },
      );
      if (!res.ok) {
        return {
          available: [...OPENROUTER_VISION_MODELS],
          filtered: false,
          error: `openrouter /models ${res.status}`,
        };
      }
      const parsed = (await res.json()) as OrListModelsResponse;
      const vision: VisionModelInfo[] = (parsed.data ?? [])
        .filter((m) => isImageReader(m.architecture))
        .map((m) => ({
          id: m.id,
          label: m.name || m.id,
          description: m.description || `OpenRouter route: ${m.id}`,
          contextTokens: m.top_provider?.context_length ?? m.context_length,
          inputPricePer1M: perMillion(m.pricing?.prompt),
          outputPricePer1M: perMillion(m.pricing?.completion),
        }));
      return {
        available: vision.length > 0 ? vision : [...OPENROUTER_VISION_MODELS],
        filtered: vision.length > 0,
        error: null,
      };
    } catch (err) {
      return {
        available: [...OPENROUTER_VISION_MODELS],
        filtered: false,
        error: errorMessage(err),
      };
    }
  },

  staticCatalog() {
    return OPENROUTER_VISION_MODELS;
  },
};
