/**
 * Request engine for the API Console.
 *
 * Resolution order for http drafts:
 *   1. `{{var}}` environment variables (baseUrl + user vars)
 *   2. `{param}` path placeholders from the draft's pathValues
 *   3. `{{secret:service/label}}` refs are LEFT INTACT — they resolve
 *      server-side only, inside the proxy, so plaintext never reaches
 *      the browser.
 *
 * Routing: same-origin requests without secret refs go straight from the
 * browser (session cookie rides along). Cross-origin requests or anything
 * carrying a secret ref goes through POST /api/dev-tools/proxy.
 */

import type {
  ConsoleResponse,
  DraftRequest,
  Environment,
  HttpMethod,
  KeyValueEntry,
} from './types';

const VAR_PATTERN = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g; // `secret:` refs don't match (no colon in class)
const PATH_PARAM_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SECRET_REF_TEST = /\{\{\s*secret:/;

/** Mirror the proxy's 2 MB cap on the direct path so a large body can't pull
 *  the whole response into React state and freeze the console. */
const MAX_DIRECT_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readCappedText(
  res: Response,
  cap: number,
): Promise<{ text: string; total: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return { text, total: new Blob([text]).size, truncated: false };
  }
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (size + value.byteLength > cap) {
      text += decoder.decode(value.subarray(0, cap - size), { stream: false });
      size = cap;
      truncated = true;
      await reader.cancel();
      break;
    }
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text, total: size, truncated };
}

export function buildVarMap(env: Environment | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (!env) return map;
  map.baseUrl = env.baseUrl;
  for (const v of env.vars) {
    if (v.enabled && v.key) map[v.key] = v.value;
  }
  return map;
}

export function substituteVars(input: string, vars: Record<string, string>): string {
  if (!input) return input;
  return input.replace(VAR_PATTERN, (match, key: string) => (key in vars ? vars[key]! : match));
}

/** Path placeholders present in a URL template (after var substitution). */
export function pathPlaceholders(url: string): string[] {
  const out: string[] = [];
  for (const m of url.matchAll(PATH_PARAM_PATTERN)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

function substitutePathParams(url: string, values: Record<string, string>): string {
  return url.replace(PATH_PARAM_PATTERN, (match, name: string) => {
    const v = values[name];
    return v === undefined || v === '' ? match : encodeURIComponent(v);
  });
}

/** Fill `{param}` placeholders raw (no encoding) — for query/header values,
 *  which the dispatcher substitutes in 'raw' mode (the URL-encode happens once
 *  downstream). Keeps the console run in step with the saved tool. */
function fillParamsRaw(s: string, values: Record<string, string>): string {
  return s.replace(PATH_PARAM_PATTERN, (match, name: string) => {
    const v = values[name];
    return v === undefined || v === '' ? match : v;
  });
}

/** Every distinct `{param}` across the URL, query values, and header values
 *  (after env-var substitution) — what the builder renders fillable chips for,
 *  so a query/header param is exercised by a console run just like the URL. */
export function collectDraftParams(draft: DraftRequest, vars: Record<string, string>): string[] {
  if (draft.kind !== 'http') return [];
  const haystack = [
    substituteVars(draft.url, vars),
    ...draft.params.filter((p) => p.enabled).map((p) => substituteVars(p.value, vars)),
    ...draft.headers.filter((h) => h.enabled).map((h) => substituteVars(h.value, vars)),
  ].join('\n');
  return pathPlaceholders(haystack);
}

function activeKv(entries: KeyValueEntry[]): KeyValueEntry[] {
  return entries.filter((e) => e.enabled && e.key.trim() !== '');
}

export type ResolvedHttpRequest = {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | null;
  needsProxy: boolean;
  unresolvedPathParams: string[];
};

export function resolveHttpDraft(
  draft: DraftRequest,
  env: Environment | null,
): ResolvedHttpRequest {
  const vars = buildVarMap(env);
  let url = substituteVars(draft.url, vars);
  const unresolved = pathPlaceholders(url).filter(
    (p) => !draft.pathValues[p] || draft.pathValues[p] === '',
  );
  url = substitutePathParams(url, draft.pathValues);

  const queryPairs = activeKv(draft.params).map(
    (p) =>
      [
        substituteVars(p.key, vars),
        fillParamsRaw(substituteVars(p.value, vars), draft.pathValues),
      ] as const,
  );
  if (queryPairs.length > 0) {
    const qs = queryPairs
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers: Record<string, string> = {};
  for (const h of activeKv(draft.headers)) {
    headers[substituteVars(h.key, vars)] = fillParamsRaw(
      substituteVars(h.value, vars),
      draft.pathValues,
    );
  }
  if (draft.auth.mode === 'bearer' && draft.auth.token) {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
      headers['Authorization'] = `Bearer ${substituteVars(draft.auth.token, vars)}`;
    }
  }

  const method = draft.method;
  let body: string | null = null;
  if (method !== 'GET' && draft.body.mode !== 'none' && draft.body.text.trim() !== '') {
    body = substituteVars(draft.body.text, vars);
    if (
      draft.body.mode === 'json' &&
      !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
    ) {
      headers['content-type'] = 'application/json';
    }
  }

  const hasSecretRef = SECRET_REF_TEST.test(url + Object.values(headers).join('\n') + (body ?? ''));
  const isAbsolute = /^https?:\/\//i.test(url);
  const crossOrigin =
    isAbsolute &&
    typeof window !== 'undefined' &&
    !url.toLowerCase().startsWith(window.location.origin.toLowerCase() + '/') &&
    url.toLowerCase() !== window.location.origin.toLowerCase();

  return {
    url,
    method,
    headers,
    body,
    needsProxy: hasSecretRef || crossOrigin,
    unresolvedPathParams: unresolved,
  };
}

function tryParseJson(text: string, contentType: string): unknown | null {
  if (!text) return null;
  if (contentType.includes('application/json') || /^[\s\n]*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

export async function sendHttpDraft(
  draft: DraftRequest,
  env: Environment | null,
  signal: AbortSignal,
): Promise<ConsoleResponse> {
  const resolved = resolveHttpDraft(draft, env);
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  if (resolved.needsProxy) {
    const res = await fetch('/api/dev-tools/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: resolved.url,
        method: resolved.method,
        headers: resolved.headers,
        body: resolved.body,
      }),
      signal,
    });
    const payload = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return {
        via: 'proxy',
        status: 0,
        statusText: 'Proxy error',
        ok: false,
        durationMs: Math.round(performance.now() - t0),
        sizeBytes: 0,
        headers: [],
        bodyText: '',
        json: null,
        networkError: String(payload.error ?? 'proxy request failed'),
        startedAt,
      };
    }
    const bodyText = String(payload.bodyText ?? '');
    const headers = (payload.headers as Array<[string, string]>) ?? [];
    const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    return {
      via: 'proxy',
      status: Number(payload.status ?? 0),
      statusText: String(payload.statusText ?? ''),
      ok: Boolean(payload.ok),
      durationMs: Number(payload.durationMs ?? 0),
      sizeBytes: Number(payload.sizeBytes ?? 0),
      truncated: Boolean(payload.truncated),
      headers,
      bodyText,
      json: tryParseJson(bodyText, ct),
      networkError: payload.networkError ? String(payload.networkError) : undefined,
      resolvedUrl: payload.resolvedUrl ? String(payload.resolvedUrl) : undefined,
      startedAt,
    };
  }

  try {
    const res = await fetch(resolved.url, {
      method: resolved.method,
      headers: resolved.headers,
      body: resolved.body ?? undefined,
      credentials: draft.auth.mode === 'session' ? 'same-origin' : 'omit',
      signal,
    });
    const { text, total, truncated } = await readCappedText(res, MAX_DIRECT_RESPONSE_BYTES);
    const durationMs = Math.round(performance.now() - t0);
    return {
      via: 'direct',
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      durationMs,
      sizeBytes: total,
      truncated,
      headers: [...res.headers.entries()],
      bodyText: text,
      json: tryParseJson(text, res.headers.get('content-type') ?? ''),
      resolvedUrl: resolved.url,
      startedAt,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      via: 'direct',
      status: 0,
      statusText: 'Network error',
      ok: false,
      durationMs,
      sizeBytes: 0,
      headers: [],
      bodyText: '',
      json: null,
      networkError: message,
      resolvedUrl: resolved.url,
      startedAt,
    };
  }
}

/** Run an agent tool (tools table row) through the real dispatcher. */
export async function sendToolCall(
  slug: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ConsoleResponse> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const res = await fetch('/api/dev-tools/execute-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, input: args }),
    signal,
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const durationMs = Number(payload.durationMs ?? Math.round(performance.now() - t0));
  const ok = res.ok && payload.ok === true;
  const display = ok ? payload.output : { error: payload.error ?? 'tool call failed' };
  const bodyText = JSON.stringify(display, null, 2) ?? '';
  return {
    via: 'tool',
    status: res.status,
    statusText: ok ? 'Tool OK' : 'Tool error',
    ok,
    durationMs,
    sizeBytes: new Blob([bodyText]).size,
    headers: [],
    bodyText,
    json: display ?? null,
    startedAt,
    artifacts: (payload.artifacts as ConsoleResponse['artifacts']) ?? undefined,
  };
}

/** Invoke an MCP tool through the stdio bridge. */
export async function sendMcpCall(
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ConsoleResponse> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const res = await fetch('/api/dev-tools/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
    signal,
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const durationMs = Math.round(performance.now() - t0);
    const errText = String(payload.error ?? 'MCP call failed');
    return {
      via: 'mcp',
      status: res.status,
      statusText: 'MCP error',
      ok: false,
      durationMs,
      sizeBytes: 0,
      headers: [],
      bodyText: errText,
      json: null,
      networkError: errText,
      startedAt,
    };
  }
  const result = (payload.result ?? {}) as {
    isError?: boolean;
    text?: string;
    durationMs?: number;
  };
  const text = result.text ?? '';
  return {
    via: 'mcp',
    status: result.isError ? 422 : 200,
    statusText: result.isError ? 'Tool error' : 'Tool OK',
    ok: !result.isError,
    durationMs: result.durationMs ?? Math.round(performance.now() - t0),
    sizeBytes: new Blob([text]).size,
    headers: [],
    bodyText: text,
    json: tryParseJson(text, 'application/json'),
    startedAt,
  };
}

/** Generate a starter args object from a JSON Schema's properties. */
export function exampleFromSchema(schema: Record<string, unknown> | null | undefined): string {
  if (!schema || typeof schema !== 'object') return '{}';
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[]) ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (!required.has(key) && Object.keys(props).length > 6) continue; // keep starters small
    const type = def.type;
    if (def.default !== undefined) out[key] = def.default;
    else if (Array.isArray(def.enum) && def.enum.length > 0) out[key] = def.enum[0];
    else if (type === 'string') out[key] = '';
    else if (type === 'number' || type === 'integer') out[key] = 0;
    else if (type === 'boolean') out[key] = false;
    else if (type === 'array') out[key] = [];
    else if (type === 'object') out[key] = {};
    else out[key] = null;
  }
  return JSON.stringify(out, null, 2);
}
