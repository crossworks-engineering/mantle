/**
 * Integration-group metadata — the PURE half: validation of the
 * `tool_groups.integration` blob, and the authoring-time inheritance that folds
 * a group's base URL + auth placement into a tool's own templates.
 *
 * Split from `integration.ts` (the db/files-backed accessors) so the rules can
 * be unit-tested without a database. Both halves are re-exported from
 * `integration.ts` / the package index — import from either.
 *
 * Secrets: `secretRef` is a `service/label` pointer and `authTemplate` values
 * carry the same `{{secret:service/label}}` strings http tool templates already
 * use. Nothing here resolves a secret — that still happens once, in the
 * dispatcher (see http-template.ts). A plaintext must never be written into
 * either field, so `parseIntegrationMeta` warns when a credential-shaped value
 * carries no ref.
 */

import type { ToolGroupIntegration } from '@mantle/db';

export type { ToolGroupIntegration };

/** `service/label`, matching the api_keys column charset + the ref pattern in
 *  http-template.ts (kept in sync by `integration-meta.test.ts`). */
const SECRET_REF_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SERVICE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A header/query name that carries a credential — flagged when its value has
 *  no `{{secret:…}}` ref (mirrors the API Console's baked-credential warning). */
const CREDENTIAL_KEY_RE = /(authorization|api[-_]?key|token|secret|password|cookie|bearer|appid)/i;
const HAS_SECRET_REF = /\{\{\s*secret:/i;

const MAX_AUTH_KEYS = 20;
const MAX_AUTH_VALUE_CHARS = 500;

export type ParsedIntegration = {
  ok: true;
  value: ToolGroupIntegration;
  warnings: string[];
};
export type IntegrationParseError = { ok: false; error: string };

function strMap(
  v: unknown,
  label: string,
): { ok: true; value: Record<string, string> } | IntegrationParseError {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: `${label} must be an object of name → template-string pairs` };
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') {
      return {
        ok: false,
        error: `${label}.${k} must be a string template (e.g. "Bearer {{secret:service/label}}")`,
      };
    }
    if (val.length > MAX_AUTH_VALUE_CHARS) {
      return { ok: false, error: `${label}.${k} is too long — keep auth templates short` };
    }
    out[k] = val;
  }
  if (Object.keys(out).length > MAX_AUTH_KEYS) {
    return {
      ok: false,
      error: `${label} carries too many keys — an auth template is the credential placement, not the whole request`,
    };
  }
  return { ok: true, value: out };
}

/**
 * Validate + normalise an `integration` blob from model input, an API request
 * body, or a DB row. Accepts both camelCase (DB/API shape) and snake_case (the
 * tool-input shape), and coerces the one thing a model plausibly gets wrong:
 * `secret_ref` handed over as the full `{{secret:svc/label}}` string is
 * unwrapped to the bare pointer.
 *
 * Returns teaching errors — callers surface them verbatim.
 */
export function parseIntegrationMeta(raw: unknown): ParsedIntegration | IntegrationParseError {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        'integration must be an object like { service, base_url?, secret_ref?, auth_template? }',
    };
  }
  const r = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const pick = (camel: string, snake: string): unknown => r[camel] ?? r[snake];

  const service = String(r.service ?? '').trim();
  if (!service) {
    return {
      ok: false,
      error:
        "integration.service is required — the vendor key for this API, e.g. 'openweathermap' (match the service you stored the key under in Settings → API keys)",
    };
  }
  if (!SERVICE_RE.test(service)) {
    return {
      ok: false,
      error: `integration.service '${service}' must be letters/digits/dot/dash/underscore (max 64) — use the vendor's short name, not a sentence`,
    };
  }

  const value: ToolGroupIntegration = { service };

  const baseUrlRaw = pick('baseUrl', 'base_url');
  if (baseUrlRaw !== undefined && baseUrlRaw !== null && String(baseUrlRaw).trim() !== '') {
    const baseUrl = String(baseUrlRaw).trim();
    if (!HTTP_URL_RE.test(baseUrl)) {
      return {
        ok: false,
        error: `integration.base_url '${baseUrl}' must start with http(s):// and contain no spaces — e.g. https://api.openweathermap.org/data/2.5`,
      };
    }
    value.baseUrl = baseUrl;
  }

  const secretRefRaw = pick('secretRef', 'secret_ref');
  if (secretRefRaw !== undefined && secretRefRaw !== null && String(secretRefRaw).trim() !== '') {
    // A model that just called api_key_refs holds `{{secret:svc/label}}` — take
    // it and store the bare pointer rather than bouncing the call.
    const secretRef = String(secretRefRaw)
      .trim()
      .replace(/^\{\{\s*secret:/i, '')
      .replace(/\s*\}\}$/, '')
      .trim();
    if (!SECRET_REF_RE.test(secretRef)) {
      return {
        ok: false,
        error: `integration.secret_ref '${secretRef}' must be 'service/label' (list the real ones with api_key_refs; the key itself is added by the owner under Settings → API keys)`,
      };
    }
    value.secretRef = secretRef;
  }

  const authRaw = pick('authTemplate', 'auth_template');
  if (authRaw !== undefined && authRaw !== null) {
    if (typeof authRaw !== 'object' || Array.isArray(authRaw)) {
      return {
        ok: false,
        error:
          'integration.auth_template must be an object with `headers` and/or `query` maps, e.g. { "query": { "appid": "{{secret:openweathermap/default}}" } }',
      };
    }
    const authObj = authRaw as Record<string, unknown>;
    const unknownKeys = Object.keys(authObj).filter((k) => k !== 'headers' && k !== 'query');
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        error: `integration.auth_template may only carry \`headers\` and \`query\` (got ${unknownKeys.join(', ')}) — a base URL goes in base_url, and per-call values belong in the tool's own templates`,
      };
    }
    const authTemplate: NonNullable<ToolGroupIntegration['authTemplate']> = {};
    for (const part of ['headers', 'query'] as const) {
      if (authObj[part] === undefined || authObj[part] === null) continue;
      const parsed = strMap(authObj[part], `integration.auth_template.${part}`);
      if (!parsed.ok) return parsed;
      if (Object.keys(parsed.value).length > 0) authTemplate[part] = parsed.value;
    }
    if (Object.keys(authTemplate).length > 0) value.authTemplate = authTemplate;
  }

  const docsNodeIdRaw = pick('docsNodeId', 'docs_node_id');
  if (
    docsNodeIdRaw !== undefined &&
    docsNodeIdRaw !== null &&
    String(docsNodeIdRaw).trim() !== ''
  ) {
    const docsNodeId = String(docsNodeIdRaw).trim();
    if (!UUID_RE.test(docsNodeId)) {
      return {
        ok: false,
        error:
          'integration.docs_node_id must be the file node id api_docs_set returned — store docs with api_docs_set rather than setting this by hand',
      };
    }
    value.docsNodeId = docsNodeId;
  }

  const sourceUrlRaw = pick('docsSourceUrl', 'docs_source_url');
  if (sourceUrlRaw !== undefined && sourceUrlRaw !== null && String(sourceUrlRaw).trim() !== '') {
    value.docsSourceUrl = String(sourceUrlRaw).trim().slice(0, 2000);
  }
  const docsUpdatedRaw = pick('docsUpdatedAt', 'docs_updated_at');
  if (docsUpdatedRaw !== undefined && docsUpdatedRaw !== null && String(docsUpdatedRaw).trim()) {
    value.docsUpdatedAt = String(docsUpdatedRaw).trim().slice(0, 40);
  }

  // Credential hygiene: a literal key pasted into the auth template would be
  // stored in the clear and read back on every group inspection. Warn (the owner
  // may legitimately place a non-secret header) rather than refuse.
  for (const part of ['headers', 'query'] as const) {
    for (const [k, v] of Object.entries(value.authTemplate?.[part] ?? {})) {
      if (v && CREDENTIAL_KEY_RE.test(k) && !HAS_SECRET_REF.test(v)) {
        warnings.push(
          `auth_template.${part}.${k} holds a literal value, not a {{secret:service/label}} vault ref — the credential would be stored in the clear; ask the owner to add the key under Settings → API keys and reference it instead`,
        );
      }
    }
  }
  if (value.secretRef && !value.authTemplate) {
    warnings.push(
      `secret_ref '${value.secretRef}' is recorded but auth_template is empty — tools authored into this group inherit no credential; set auth_template to say WHERE it goes, e.g. { "headers": { "Authorization": "Bearer {{secret:${value.secretRef}}}" } }`,
    );
  }

  return { ok: true, value, warnings };
}

/* ─────────────────── authoring-time inheritance (pure) ─────────────────── */

/**
 * Join a relative tool path onto the integration's base URL. Pure string work —
 * no URL parsing — so `{param}` placeholders survive untouched.
 */
export function joinBaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const rel = path.trim();
  if (rel === '') return base;
  if (rel.startsWith('?') || rel.startsWith('#')) return base + rel;
  return `${base}/${rel.replace(/^\/+/, '')}`;
}

export type InheritanceInput = {
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
};

/** What the group contributed — reported back so the agent sees it. */
export type InheritedPieces = {
  baseUrl?: string;
  /** Header names the group supplied. */
  headers: string[];
  /** Query keys the group supplied. */
  query: string[];
  /** Group keys the tool's own value won over. */
  overridden: string[];
};

export type InheritanceResult =
  | {
      ok: true;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      inherited: InheritedPieces;
    }
  | { ok: false; error: string };

/**
 * Fold an integration group's `baseUrl` + `authTemplate` into a tool's own
 * templates. The TOOL WINS on every conflict (its own header/query value is
 * kept), an absolute `url` is left alone, and a relative `url` is joined onto
 * the group's base. Header conflicts match case-insensitively so a tool's
 * `authorization` overrides the group's `Authorization` instead of both being
 * sent.
 *
 * Runs at authoring time — the returned pieces are what gets STORED in the
 * handler, so the dispatcher and every existing tool stay untouched.
 */
export function applyIntegrationInheritance(
  integration: ToolGroupIntegration | null,
  input: InheritanceInput,
): InheritanceResult {
  const url = input.url.trim();
  const absolute = HTTP_URL_RE.test(url);
  const inherited: InheritedPieces = { headers: [], query: [], overridden: [] };

  if (!integration) {
    if (!absolute) {
      return {
        ok: false,
        error: `url '${url}' must start with http(s):// — a relative path only works when the tool joins an integration group carrying a base_url (pass group_slug, or set base_url with tool_group_ensure)`,
      };
    }
    return { ok: true, url, headers: input.headers, query: input.query, inherited };
  }

  let finalUrl = url;
  if (!absolute) {
    if (!integration.baseUrl) {
      return {
        ok: false,
        error: `url '${url}' is relative but the integration group has no base_url — pass an absolute http(s):// url, or set base_url on the group with tool_group_ensure`,
      };
    }
    finalUrl = joinBaseUrl(integration.baseUrl, url);
    inherited.baseUrl = integration.baseUrl;
  }

  const toolHeaders = input.headers ?? {};
  const toolHeaderKeys = new Set(Object.keys(toolHeaders).map((k) => k.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(integration.authTemplate?.headers ?? {})) {
    if (toolHeaderKeys.has(k.toLowerCase())) {
      inherited.overridden.push(k);
      continue;
    }
    headers[k] = v;
    inherited.headers.push(k);
  }
  Object.assign(headers, toolHeaders);

  const toolQuery = input.query ?? {};
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(integration.authTemplate?.query ?? {})) {
    if (k in toolQuery) {
      inherited.overridden.push(k);
      continue;
    }
    query[k] = v;
    inherited.query.push(k);
  }
  Object.assign(query, toolQuery);

  return {
    ok: true,
    url: finalUrl,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
    inherited,
  };
}

/** One-line summary of what a group contributed, for a tool result. */
export function describeInheritance(inherited: InheritedPieces): string {
  const parts: string[] = [];
  if (inherited.baseUrl) parts.push(`base_url ${inherited.baseUrl}`);
  if (inherited.headers.length > 0) parts.push(`headers ${inherited.headers.join(', ')}`);
  if (inherited.query.length > 0) parts.push(`query ${inherited.query.join(', ')}`);
  const kept =
    inherited.overridden.length > 0
      ? ` (the tool's own ${inherited.overridden.join(', ')} won over the group's)`
      : '';
  if (parts.length === 0) return `nothing inherited from the group${kept}`;
  return `inherited from the integration group: ${parts.join('; ')}${kept}`;
}

/* ───────────────────────── stored API documentation ───────────────────── */

/** Cap on a stored docs file. Docs are prose, not a data dump, and 1 MB is the
 *  files layer's `data.content` cache ceiling — stay well under it. */
export const API_DOCS_MAX_CHARS = 400_000;

/** Provenance banner prepended to every stored docs file, so a later reader
 *  (human or agent) can tell where the text came from and how stale it is. */
export function apiDocsHeader(args: {
  groupSlug: string;
  service?: string;
  sourceUrl?: string;
  capturedAt?: string;
}): string {
  const captured = args.capturedAt ?? new Date().toISOString();
  return [
    `# ${args.service ?? args.groupSlug} API documentation`,
    '',
    `- Integration group: \`${args.groupSlug}\``,
    `- Source: ${args.sourceUrl && args.sourceUrl.trim() ? args.sourceUrl.trim() : 'supplied directly (no URL)'}`,
    `- Captured: ${captured}`,
    '',
    'Stored on this brain — read it with api_docs_get before re-fetching the web.',
    '',
    '---',
    '',
  ].join('\n');
}
