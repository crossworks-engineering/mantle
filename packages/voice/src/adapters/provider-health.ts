/**
 * THE "is the local model up" probe, for the dashboard pill, the sanity
 * check, the capabilities panel and the services switch: GET
 * `<base>/models` with a short deadline, read the OpenAI-compatible
 * `data[].id` list, and match the configured model with Ollama's `:latest`
 * tolerated on either side. Each caller words its own answer.
 *
 * Through providerFetch: a local model is a configured provider base URL, the
 * same host the embed and chat calls reach.
 */
import { providerFetch } from './provider-fetch';

export type ProviderHealth =
  /** The server answered its model list. `ids` is null when the answer was
   *  not a readable list; `loaded` is null when no model was asked about. */
  | { up: true; ids: string[] | null; loaded: boolean | null }
  /** The server answered with an error status. */
  | { up: false; reason: 'http'; status: number }
  /** No answer: refused, unresolvable, or past the deadline. */
  | { up: false; reason: 'unreachable' };

/** Model ids match with Ollama's `:latest` tolerated on either side, so a
 *  bare-name config matches `embeddinggemma:latest`. */
export function sameLocalModel(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/:latest$/, '');
  return norm(a) === norm(b);
}

/** Probe an OpenAI-compatible server's model list at `baseUrl` (trailing
 *  slashes ignored). Never throws. */
export async function providerHealth(
  baseUrl: string,
  opts: { timeoutMs: number; model?: string },
): Promise<ProviderHealth> {
  const base = baseUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await providerFetch(`${base}/models`, {}, { timeoutMs: opts.timeoutMs });
  } catch {
    return { up: false, reason: 'unreachable' };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { up: false, reason: 'http', status: res.status };
  }
  let ids: string[] | null;
  try {
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
  } catch {
    ids = null;
  }
  const model = opts.model;
  return {
    up: true,
    ids,
    loaded:
      model === undefined || ids === null ? null : ids.some((id) => sameLocalModel(id, model)),
  };
}
