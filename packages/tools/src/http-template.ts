/**
 * Templating for `http` tool handlers — the pure half of dispatchHttp.
 *
 * Two placeholder syntaxes, resolved at dispatch time:
 *
 *   `{param}`                      — filled from the tool-call input. URL-encoded
 *                                    in the URL, raw in query values + headers,
 *                                    JSON-encoded in the body template.
 *   `{{secret:service/label}}`     — decrypted from the api_keys vault. The
 *                                    plaintext never reaches the model: inputs
 *                                    can't inject refs (substitution order), and
 *                                    `scrubSecrets` strips plaintexts from any
 *                                    error text before it leaves the dispatcher.
 *
 * Input fields not consumed by any template spill over: into the JSON body for
 * non-GET requests (preserving the legacy whole-input-as-body behavior for
 * handlers with no templates at all), or into query params for GET/HEAD.
 */

import { randomUUID } from 'node:crypto';

import type { ToolHandler } from '@mantle/db';

export type HttpHandler = Extract<ToolHandler, { kind: 'http' }>;

export type SecretRef = { service: string; label: string };

/** `{{secret:service/label}}` — service/label match the api_keys columns. */
const SECRET_REF_PATTERN = /\{\{\s*secret:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*\}\}/g;

/** `{param}` — a brace-wrapped identifier. Secret refs can't false-match:
 *  `:` and `/` aren't in the identifier class, and in buildHttpRequest the
 *  refs are tokenized away before this pattern ever runs. */
const PARAM_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function refKey(ref: SecretRef): string {
  return `${ref.service}/${ref.label}`;
}

/** Every template string an http handler can carry, in one list. */
export function templateStrings(h: HttpHandler): string[] {
  const out: string[] = [h.url];
  for (const v of Object.values(h.headers ?? {})) out.push(v);
  for (const v of Object.values(h.query ?? {})) out.push(v);
  if (h.body) out.push(h.body);
  return out;
}

/** Collect distinct `{{secret:…}}` refs across the handler's templates. */
export function collectSecretRefs(h: HttpHandler): SecretRef[] {
  const seen = new Map<string, SecretRef>();
  for (const s of templateStrings(h)) {
    for (const m of s.matchAll(SECRET_REF_PATTERN)) {
      const ref = { service: m[1]!, label: m[2]! };
      seen.set(refKey(ref), ref);
    }
  }
  return [...seen.values()];
}

/** Collect distinct `{param}` names across the handler's templates. */
export function collectParamNames(h: HttpHandler): string[] {
  const seen = new Set<string>();
  for (const s of templateStrings(h)) {
    for (const m of s.matchAll(PARAM_PATTERN)) seen.add(m[1]!);
  }
  return [...seen];
}

type ParamEncoding = 'url' | 'raw' | 'json';

function encodeParam(value: unknown, mode: ParamEncoding): string {
  if (mode === 'json') return JSON.stringify(value === undefined ? null : value);
  let s: string;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'string') s = value;
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
  else s = JSON.stringify(value);
  // Strip NUL bytes: they delimit secret tokens (see buildHttpRequest), so an
  // input value carrying one could otherwise smuggle a token into raw output.
  // eslint-disable-next-line no-control-regex -- stripping NUL is intentional
  s = s.replace(/\u0000/g, '');
  return mode === 'url' ? encodeURIComponent(s) : s;
}

function substituteParams(
  template: string,
  input: Record<string, unknown>,
  mode: ParamEncoding,
  used: Set<string>,
): string {
  return template.replace(PARAM_PATTERN, (match, name: string) => {
    if (!(name in input)) return match; // unfilled placeholders stay visible
    used.add(name);
    return encodeParam(input[name], mode);
  });
}

export type BuiltHttpRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

/**
 * Assemble the final request from handler templates + tool-call input +
 * resolved secrets. Pure — secret resolution happens in the dispatcher.
 *
 * Injection safety: secret refs are swapped for opaque tokens BEFORE param
 * substitution and swapped back after, so only refs the tool author wrote
 * into the templates ever resolve. A model passing `{{secret:…}}` as an
 * input value gets a literal string, never the plaintext.
 */
export function buildHttpRequest(
  h: HttpHandler,
  input: Record<string, unknown>,
  secrets: Map<string, string>,
): BuiltHttpRequest {
  const used = new Set<string>();

  // Pre-pass: swap secret refs in the *author's* templates for opaque tokens
  // so input-injected `{{secret:…}}` strings can never resolve.
  const tokens = new Map<string, string>();
  let tokenSeq = 0;
  // Random per-call nonce so the token is unguessable: a model can't pass an
  // input value that reconstructs a live token and round-trips a secret out
  // (input NUL bytes are also stripped in encodeParam as a second line).
  const nonce = randomUUID();
  const tokenize = (s: string): string =>
    s.replace(SECRET_REF_PATTERN, (m, service: string, label: string) => {
      const plaintext = secrets.get(`${service}/${label}`);
      if (plaintext === undefined) return m;
      const token = '\u0000S' + nonce + ':' + tokenSeq++ + '\u0000';
      tokens.set(token, plaintext);
      return token;
    });
  const detokenize = (s: string, urlEncode = false): string => {
    let out = s;
    for (const [token, plaintext] of tokens) {
      out = out.split(token).join(urlEncode ? encodeURIComponent(plaintext) : plaintext);
    }
    return out;
  };

  // URL: tokenize secrets, fill params (url-encoded), then restore secrets.
  let url = detokenize(substituteParams(tokenize(h.url), input, 'url', used));

  // Query: explicit map first, with templating in values.
  const queryPairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(h.query ?? {})) {
    queryPairs.push([k, detokenize(substituteParams(tokenize(v), input, 'raw', used))]);
  }

  // Headers.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(h.headers ?? {})) {
    headers[k] = detokenize(substituteParams(tokenize(v), input, 'raw', used));
  }

  // Body.
  const method = (h.method ?? 'POST').toUpperCase();
  const canHaveBody = method !== 'GET' && method !== 'HEAD';
  let body: string | null = null;
  if (h.body != null && h.body !== '') {
    body = detokenize(substituteParams(tokenize(h.body), input, 'json', used));
  }

  // Spillover: input fields no template consumed.
  const leftover: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!used.has(k)) leftover[k] = v;
  }
  const leftoverKeys = Object.keys(leftover);
  if (leftoverKeys.length > 0) {
    if (!canHaveBody) {
      for (const k of leftoverKeys) queryPairs.push([k, encodeParam(leftover[k], 'raw')]);
    } else if (body === null) {
      body = JSON.stringify(leftover);
    }
    // Non-GET with an explicit body template: leftovers are dropped — the
    // author chose exactly what the request carries.
  }

  if (queryPairs.length > 0) {
    const qs = queryPairs
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  if (body !== null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }

  return { url, method, headers, body: canHaveBody ? body : null };
}

/** Replace every resolved secret plaintext in `text` with its ref name —
 *  run over anything that can leave the dispatcher (errors, step meta,
 *  response bodies). Covers the common transport encodings of the secret:
 *  raw, URL-encoded, and base64 (how Basic-auth credentials travel, and a
 *  form upstreams often echo back). */
export function scrubSecrets(text: string, secrets: Map<string, string>): string {
  let out = text;
  for (const [key, plaintext] of secrets) {
    if (!plaintext) continue;
    const variants = new Set<string>([plaintext, encodeURIComponent(plaintext)]);
    try {
      variants.add(Buffer.from(plaintext, 'utf8').toString('base64'));
    } catch {
      /* non-encodable — skip */
    }
    for (const v of variants) {
      if (v && v.length > 0) out = out.split(v).join(`[secret:${key}]`);
    }
  }
  return out;
}
