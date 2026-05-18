/**
 * Minimal OpenRouter embeddings HTTP client. No SDK dependency — the
 * /embeddings endpoint is simple enough that fetch() is cleaner than
 * pulling in another library.
 *
 * Endpoint: POST https://openrouter.ai/api/v1/embeddings
 * Request:  { model: 'openai/text-embedding-3-small', input: 'text' | string[] }
 * Response: { data: [{ embedding: number[], index: number }, ...], usage }
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';

export type EmbeddingsRequest = {
  model: string;
  input: string | string[];
};

type RawResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

export async function callEmbeddings(
  apiKey: string,
  body: EmbeddingsRequest,
): Promise<number[][]> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'http-referer': 'https://mantle.crossworks.network',
      'x-title': 'Mantle',
    },
    body: JSON.stringify(body),
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
