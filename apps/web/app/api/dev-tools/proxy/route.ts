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
 * The route sits behind requireOwner like everything else.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getApiKey } from '@mantle/api-keys';
import {
  buildHttpRequest,
  collectSecretRefs,
  refKey,
  scrubSecrets,
  type HttpHandler,
} from '@mantle/tools';
import { requireOwner } from '@/lib/auth';

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

export async function POST(req: Request) {
  const user = await requireOwner();
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
    const res = await fetch(built.url, {
      method,
      headers: built.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (built.body ?? undefined),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    const buf = await res.arrayBuffer();
    const durationMs = Math.round(performance.now() - t0);
    const truncated = buf.byteLength > MAX_RESPONSE_BYTES;
    const text = new TextDecoder().decode(
      truncated ? buf.slice(0, MAX_RESPONSE_BYTES) : buf,
    );
    return NextResponse.json({
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      durationMs,
      sizeBytes: buf.byteLength,
      truncated,
      headers: [...res.headers.entries()],
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
