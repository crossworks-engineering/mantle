/**
 * API Console request proxy. The console fires same-origin requests
 * directly from the browser (session cookie, no CORS); everything else —
 * external APIs, and any request whose templates reference
 * `{{secret:service/label}}` — goes through here so:
 *
 *   1. CORS never blocks a test (the fetch is server-side), and
 *   2. vault secrets are resolved server-side and the plaintext never
 *      reaches the browser. Refs are substituted via the same tokenizing
 *      builder agents use, and the resolved values are scrubbed from the
 *      echoed URL and any error text.
 *
 * SSRF note: this lets the owner's browser make the server fetch arbitrary
 * URLs — which is the feature, not a bug, on a single-owner deployment
 * (it's the same power the owner's own `http` agent tools already have).
 * The route sits behind getOwnerOr401 like every other /api route.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getApiKey } from '@mantle/api-keys';
import {
  buildHttpRequest,
  collectSecretRefs,
  refKey,
  safeFetch,
  scrubSecrets,
  type HttpHandler,
} from '@mantle/tools';
import { getOwnerOr401 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const Body = z.object({
  url: z
    .string()
    .min(1)
    .max(4000)
    .regex(/^https?:\/\/\S+$/i, 'url must start with http(s)://'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
  headers: z.record(z.string().min(1).max(200), z.string().max(4000)).default({}),
  body: z.string().max(1_000_000).nullable().default(null),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
});

/**
 * Read at most `cap` bytes from the response, then stop and cancel the stream —
 * so pointing the console at a multi-GB download doesn't buffer it all. Returns
 * the captured bytes plus the true total when it fit under the cap.
 */
async function readCapped(
  res: Response,
  cap: number,
): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), total: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > cap) {
        const keep = value.byteLength - (size - cap);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  const captured = chunks.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(captured);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, total: truncated ? size : captured, truncated };
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { url, method, headers, body, timeoutMs } = parsed.data;

  // Reuse the handler templating machinery for secret resolution only —
  // the console has already substituted {param} placeholders client-side,
  // so the only templates left to resolve are vault refs.
  const handler: HttpHandler = {
    kind: 'http',
    url,
    method: method === 'HEAD' ? 'GET' : method,
    headers,
    body,
  };
  const secrets = new Map<string, string>();
  for (const ref of collectSecretRefs(handler)) {
    const plaintext = await getApiKey(user.id, ref.service, ref.label);
    if (plaintext === null) {
      return NextResponse.json(
        {
          error: `secret '${refKey(ref)}' not found in the API-key vault — add it under Settings → API keys`,
        },
        { status: 400 },
      );
    }
    secrets.set(refKey(ref), plaintext);
  }
  const built = buildHttpRequest(handler, {}, secrets);
  const scrub = (s: string) => scrubSecrets(s, secrets);

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  try {
    const res = await safeFetch(
      built.url,
      {
        method,
        headers: built.headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : (built.body ?? undefined),
        signal: AbortSignal.timeout(timeoutMs),
      },
      [...secrets.values()],
    );
    const { bytes, total, truncated } = await readCapped(res, MAX_RESPONSE_BYTES);
    const durationMs = Math.round(performance.now() - t0);
    const text = new TextDecoder().decode(bytes);
    return NextResponse.json({
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      durationMs,
      sizeBytes: total,
      truncated,
      // Scrub echoed response headers too — some gateways reflect the api key.
      headers: [...res.headers.entries()].map(([k, v]) => [k, scrub(v)]),
      bodyText: scrub(text),
      resolvedUrl: scrub(built.url),
      startedAt,
    });
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return NextResponse.json({
      status: 0,
      statusText: 'Network error',
      ok: false,
      durationMs,
      sizeBytes: 0,
      truncated: false,
      headers: [],
      bodyText: '',
      networkError: scrub(msg),
      resolvedUrl: scrub(built.url),
      startedAt,
    });
  }
}
