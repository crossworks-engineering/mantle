/**
 * Minimal OpenRouter embeddings HTTP client. No SDK dependency — the
 * /embeddings endpoint is simple enough that fetch() is cleaner than
 * pulling in another library.
 *
 * Endpoint: POST https://openrouter.ai/api/v1/embeddings
 *
 * Text-only:
 *   Request:  { model: 'openai/text-embedding-3-small', input: string | string[] }
 *   Response: { data: [{ embedding: number[], index: number }, ...], usage }
 *
 * Multimodal (gemini-embedding-2-preview, nvidia/llama-nemotron-embed-vl):
 *   Input items can be { text } | { image_url: { url } } | { audio_url: { url } } |
 *   { file_url: { url, mime_type? } }.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';

/** Models that accept non-text inputs. Add as new ones land on OpenRouter. */
export const MULTIMODAL_MODELS = new Set<string>([
  'google/gemini-embedding-2-preview',
  'nvidia/llama-nemotron-embed-vl-1b-v2',
]);

export function isMultimodalModel(model: string): boolean {
  return MULTIMODAL_MODELS.has(model);
}

/**
 * Plain text input — string or `{ type: 'text', text }`.
 * Image / audio / file inputs require a multimodal model.
 */
export type EmbedInput =
  | string
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'audio'; url: string }
  | { type: 'file'; url: string; mimeType?: string };

export type EmbeddingsRequest = {
  model: string;
  input: string | string[] | EmbedInput[];
  /** Gemini honours this to truncate to a smaller output dim. We pass 1536
   *  so the result fits our pgvector column without a schema change. */
  outputDimensionality?: number;
};

type RawResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

function toRawInput(
  input: EmbeddingsRequest['input'],
): string | string[] | Record<string, unknown>[] {
  if (typeof input === 'string') return input;
  if (input.every((i) => typeof i === 'string')) return input as string[];
  // Mixed/multimodal: normalise each element to the provider's shape.
  return (input as EmbedInput[]).map((item) => {
    if (typeof item === 'string') return { text: item };
    switch (item.type) {
      case 'text':
        return { text: item.text };
      case 'image':
        return { image_url: { url: item.url } };
      case 'audio':
        return { audio_url: { url: item.url } };
      case 'file':
        return {
          file_url: {
            url: item.url,
            ...(item.mimeType ? { mime_type: item.mimeType } : {}),
          },
        };
    }
  });
}

export async function callEmbeddings(
  apiKey: string,
  body: EmbeddingsRequest,
): Promise<number[][]> {
  const rawBody: Record<string, unknown> = {
    model: body.model,
    input: toRawInput(body.input),
  };
  if (body.outputDimensionality && isMultimodalModel(body.model)) {
    rawBody.output_dimensionality = body.outputDimensionality;
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'http-referer': 'https://mantle.crossworks.network',
      'x-title': 'Mantle',
    },
    body: JSON.stringify(rawBody),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `OpenRouter embeddings failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as RawResponse;
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('OpenRouter embeddings: malformed response (no data array)');
  }

  // Sort by index just in case the upstream doesn't preserve order.
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}
