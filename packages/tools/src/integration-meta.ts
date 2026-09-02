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

import type {
  ToolGroupIntegration,
  ToolGroupMcpBinding,
  ToolGroupOpenapiBinding,
} from '@mantle/db';
import { UUID_RE } from '@mantle/std';

export type { ToolGroupIntegration, ToolGroupMcpBinding, ToolGroupOpenapiBinding };

/** `service/label`, matching the api_keys column charset + the ref pattern in
 *  http-template.ts (kept in sync by `integration-meta.test.ts`). */
const SECRET_REF_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SERVICE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;
const SKILL_SLUG_RE = /^[a-z0-9_-]{1,120}$/;
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

  const skillSlugRaw = pick('skillSlug', 'skill_slug');
  if (skillSlugRaw !== undefined && skillSlugRaw !== null && String(skillSlugRaw).trim() !== '') {
    const skillSlug = String(skillSlugRaw).trim();
    if (!SKILL_SLUG_RE.test(skillSlug)) {
      return {
        ok: false,
        error: `integration.skill_slug '${skillSlug}' must be lowercase letters/digits/dash/underscore — write the usage skill with api_skill_set, which names it for you`,
      };
    }
    value.skillSlug = skillSlug;
  }

  const mcpRaw = r.mcp;
  if (mcpRaw !== undefined && mcpRaw !== null) {
    const parsedMcp = parseMcpBinding(mcpRaw);
    if (!parsedMcp.ok) return parsedMcp;
    value.mcp = parsedMcp.value;
  }

  const openapiRaw = r.openapi;
  if (openapiRaw !== undefined && openapiRaw !== null) {
    const parsedOpenapi = parseOpenapiBinding(openapiRaw);
    if (!parsedOpenapi.ok) return parsedOpenapi;
    value.openapi = parsedOpenapi.value;
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

const AUTH_HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_AUTH_SCHEME_CHARS = 20;

/**
 * The vault namespace MCP connectors seal their OAuth state under (service =
 * the connector's `mcp-<slug>` group slug). RESERVED: these rows hold live
 * bearer tokens and sometimes a registration client_secret nobody ever typed
 * in, so they must never be usable as `{{secret:…}}` template refs, listed by
 * `api_key_refs`, probed/shown as ordinary keys, or named as a binding's
 * `secret_ref`. Enforced in the dispatcher, `api_key_refs`, the keys API, and
 * `parseMcpBinding` below.
 */
export const MCP_VAULT_SERVICE_PREFIX = 'mcp-';
export function isMcpManagedSecretService(service: string): boolean {
  return service.startsWith(MCP_VAULT_SERVICE_PREFIX);
}

/**
 * Validate + normalise the `integration.mcp` connector binding. Accepts camel
 * and snake case, unwraps a full `{{secret:svc/label}}` handed as `secret_ref`,
 * and carries the sync-bookkeeping fields (`lastSyncAt`, `toolCount`,
 * `serverInfo`) through so a validated round-trip of a DB row doesn't drop
 * the connector's sync state.
 */
export function parseMcpBinding(
  raw: unknown,
): { ok: true; value: ToolGroupMcpBinding } | IntegrationParseError {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        'integration.mcp must be an object like { url, secret_ref?, auth_header?, auth_scheme? }',
    };
  }
  const r = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown => r[camel] ?? r[snake];

  const url = String(r.url ?? '').trim();
  if (!HTTP_URL_RE.test(url)) {
    return {
      ok: false,
      error: `integration.mcp.url '${url}' must be the server's streamable-HTTP endpoint, starting with http(s):// and containing no spaces — e.g. https://mcp.firecrawl.dev/v2/mcp`,
    };
  }
  const value: ToolGroupMcpBinding = { url };

  const secretRefRaw = pick('secretRef', 'secret_ref');
  if (secretRefRaw !== undefined && secretRefRaw !== null && String(secretRefRaw).trim() !== '') {
    const secretRef = String(secretRefRaw)
      .trim()
      .replace(/^\{\{\s*secret:/i, '')
      .replace(/\s*\}\}$/, '')
      .trim();
    if (!SECRET_REF_RE.test(secretRef)) {
      return {
        ok: false,
        error: `integration.mcp.secret_ref '${secretRef}' must be 'service/label' (list the real ones with api_key_refs; the key itself is added by the owner under Settings → API keys)`,
      };
    }
    if (isMcpManagedSecretService(secretRef)) {
      return {
        ok: false,
        error: `integration.mcp.secret_ref '${secretRef}' points into the reserved 'mcp-' namespace (connector-sealed OAuth state) — reference a key the owner added under Settings → API keys instead`,
      };
    }
    value.secretRef = secretRef;
  }

  const authHeaderRaw = pick('authHeader', 'auth_header');
  if (
    authHeaderRaw !== undefined &&
    authHeaderRaw !== null &&
    String(authHeaderRaw).trim() !== ''
  ) {
    const authHeader = String(authHeaderRaw).trim();
    if (!AUTH_HEADER_RE.test(authHeader)) {
      return {
        ok: false,
        error: `integration.mcp.auth_header '${authHeader}' must be a plain header name (letters/digits/dash) — e.g. Authorization or X-API-Key`,
      };
    }
    value.authHeader = authHeader;
  }

  const authSchemeRaw = pick('authScheme', 'auth_scheme');
  if (authSchemeRaw !== undefined && authSchemeRaw !== null) {
    const authScheme = String(authSchemeRaw);
    if (authScheme.length > MAX_AUTH_SCHEME_CHARS || HAS_SECRET_REF.test(authScheme)) {
      return {
        ok: false,
        error: `integration.mcp.auth_scheme must be a short prefix like 'Bearer ' (or '' to send the credential bare) — the credential itself stays in the vault as secret_ref`,
      };
    }
    value.authScheme = authScheme;
  }

  // Sync bookkeeping — written by the connector sync; validated lightly so a
  // round-trip of a stored row preserves it without letting junk grow.
  const lastSyncRaw = pick('lastSyncAt', 'last_sync_at');
  if (lastSyncRaw !== undefined && lastSyncRaw !== null && String(lastSyncRaw).trim() !== '') {
    value.lastSyncAt = String(lastSyncRaw).trim().slice(0, 40);
  }
  const toolCountRaw = pick('toolCount', 'tool_count');
  if (toolCountRaw !== undefined && toolCountRaw !== null) {
    const n = Number(toolCountRaw);
    if (Number.isInteger(n) && n >= 0) value.toolCount = n;
  }
  const serverInfoRaw = pick('serverInfo', 'server_info');
  if (serverInfoRaw && typeof serverInfoRaw === 'object' && !Array.isArray(serverInfoRaw)) {
    const si = serverInfoRaw as Record<string, unknown>;
    const serverInfo: NonNullable<ToolGroupMcpBinding['serverInfo']> = {};
    if (typeof si.name === 'string' && si.name.trim())
      serverInfo.name = si.name.trim().slice(0, 200);
    if (typeof si.version === 'string' && si.version.trim()) {
      serverInfo.version = si.version.trim().slice(0, 60);
    }
    if (Object.keys(serverInfo).length > 0) value.serverInfo = serverInfo;
  }

  // OAuth bookkeeping — non-secret state only (tokens/registration/verifier
  // live sealed in the vault). Validated so a round-trip preserves it and a
  // model can never smuggle junk or a credential into the row.
  const oauthRaw = r.oauth;
  if (oauthRaw !== undefined && oauthRaw !== null) {
    if (typeof oauthRaw !== 'object' || Array.isArray(oauthRaw)) {
      return {
        ok: false,
        error:
          'integration.mcp.oauth must be an object — set { enabled: true } to mark the connector as OAuth-authenticated (the flow itself is driven via the connectors API, not by editing this field)',
      };
    }
    const o = oauthRaw as Record<string, unknown>;
    const pickO = (camel: string, snake: string): unknown => o[camel] ?? o[snake];
    if (o.enabled !== true) {
      return {
        ok: false,
        error:
          'integration.mcp.oauth.enabled must be exactly true — to drop OAuth from a connector, clear the whole oauth object instead',
      };
    }
    const status = String(o.status ?? 'pending');
    if (!['pending', 'connected', 'needs_reconnect'].includes(status)) {
      return {
        ok: false,
        error: `integration.mcp.oauth.status '${status}' must be pending | connected | needs_reconnect`,
      };
    }
    const oauth: NonNullable<ToolGroupMcpBinding['oauth']> = {
      enabled: true,
      status: status as 'pending' | 'connected' | 'needs_reconnect',
    };
    const clientIdRaw = pickO('clientId', 'client_id');
    if (typeof clientIdRaw === 'string' && clientIdRaw.trim()) {
      oauth.clientId = clientIdRaw.trim().slice(0, 300);
    }
    const pendingRaw = o.pending;
    if (pendingRaw && typeof pendingRaw === 'object' && !Array.isArray(pendingRaw)) {
      const p = pendingRaw as Record<string, unknown>;
      const state = String(p.state ?? '').trim();
      const redirectUri = String(p.redirectUri ?? p.redirect_uri ?? '').trim();
      const startedAt = String(p.startedAt ?? p.started_at ?? '').trim();
      if (state && HTTP_URL_RE.test(redirectUri)) {
        oauth.pending = {
          state: state.slice(0, 100),
          redirectUri: redirectUri.slice(0, 2000),
          startedAt: startedAt.slice(0, 40),
        };
      }
    }
    const redirectUriRaw = pickO('redirectUri', 'redirect_uri');
    if (typeof redirectUriRaw === 'string' && HTTP_URL_RE.test(redirectUriRaw.trim())) {
      oauth.redirectUri = redirectUriRaw.trim().slice(0, 2000);
    }
    for (const [camel, snake] of [
      ['tokenExpiresAt', 'token_expires_at'],
      ['connectedAt', 'connected_at'],
    ] as const) {
      const v = pickO(camel, snake);
      if (typeof v === 'string' && v.trim()) oauth[camel] = v.trim().slice(0, 40);
    }
    const lastErrorRaw = pickO('lastError', 'last_error');
    if (typeof lastErrorRaw === 'string' && lastErrorRaw.trim()) {
      oauth.lastError = lastErrorRaw.trim().slice(0, 500);
    }
    value.oauth = oauth;
  }

  return { ok: true, value };
}

const SELECTION_MAX_TAGS = 40;
const SELECTION_MAX_OPERATIONS = 200;
const SELECTION_ITEM_MAX_CHARS = 200;

/**
 * Validate + normalise the `integration.openapi` connector binding. Accepts
 * camel and snake case and carries the sync-bookkeeping fields (`specHash`,
 * `apiTitle`, `apiVersion`, `lastSyncAt`, `toolCount`) through so a validated
 * round-trip of a stored row doesn't drop the connector's sync state.
 */
export function parseOpenapiBinding(
  raw: unknown,
): { ok: true; value: ToolGroupOpenapiBinding } | IntegrationParseError {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: 'integration.openapi must be an object like { spec_url, selection? }',
    };
  }
  const r = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown => r[camel] ?? r[snake];

  const specUrl = String(pick('specUrl', 'spec_url') ?? '').trim();
  if (!HTTP_URL_RE.test(specUrl)) {
    return {
      ok: false,
      error: `integration.openapi.spec_url '${specUrl}' must be the URL of the service's OpenAPI 3.x document, starting with http(s):// and containing no spaces — e.g. https://example.com/openapi.json`,
    };
  }
  const value: ToolGroupOpenapiBinding = { specUrl };

  const selectionRaw = r.selection;
  if (selectionRaw !== undefined && selectionRaw !== null) {
    if (typeof selectionRaw !== 'object' || Array.isArray(selectionRaw)) {
      return {
        ok: false,
        error:
          'integration.openapi.selection must be an object with `tags` and/or `operations` string arrays — e.g. { "operations": ["getForecast"] }; omit it to include every operation (only legal under the per-connector tool cap)',
      };
    }
    const sel = selectionRaw as Record<string, unknown>;
    const unknownKeys = Object.keys(sel).filter((k) => k !== 'tags' && k !== 'operations');
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        error: `integration.openapi.selection may only carry \`tags\` and \`operations\` (got ${unknownKeys.join(', ')})`,
      };
    }
    const selection: NonNullable<ToolGroupOpenapiBinding['selection']> = {};
    for (const [key, cap] of [
      ['tags', SELECTION_MAX_TAGS],
      ['operations', SELECTION_MAX_OPERATIONS],
    ] as const) {
      const arr = sel[key];
      if (arr === undefined || arr === null) continue;
      if (!Array.isArray(arr) || arr.some((v) => typeof v !== 'string')) {
        return {
          ok: false,
          error: `integration.openapi.selection.${key} must be an array of strings`,
        };
      }
      const items = [
        ...new Set(
          (arr as string[]).map((s) => s.trim().slice(0, SELECTION_ITEM_MAX_CHARS)).filter(Boolean),
        ),
      ];
      if (items.length > cap) {
        return {
          ok: false,
          error: `integration.openapi.selection.${key} carries ${items.length} entries (max ${cap}) — select with tags, or narrow the list`,
        };
      }
      if (items.length > 0) selection[key] = items;
    }
    if (Object.keys(selection).length > 0) value.selection = selection;
  }

  // Sync bookkeeping — written by the connector sync; validated lightly so a
  // round-trip of a stored row preserves it without letting junk grow.
  const specHashRaw = pick('specHash', 'spec_hash');
  if (typeof specHashRaw === 'string' && /^[0-9a-f]{16,64}$/i.test(specHashRaw.trim())) {
    value.specHash = specHashRaw.trim().toLowerCase();
  }
  const titleRaw = pick('apiTitle', 'api_title');
  if (typeof titleRaw === 'string' && titleRaw.trim()) {
    value.apiTitle = titleRaw.trim().slice(0, 200);
  }
  const versionRaw = pick('apiVersion', 'api_version');
  if (typeof versionRaw === 'string' && versionRaw.trim()) {
    value.apiVersion = versionRaw.trim().slice(0, 60);
  }
  const lastSyncRaw = pick('lastSyncAt', 'last_sync_at');
  if (lastSyncRaw !== undefined && lastSyncRaw !== null && String(lastSyncRaw).trim() !== '') {
    value.lastSyncAt = String(lastSyncRaw).trim().slice(0, 40);
  }
  const toolCountRaw = pick('toolCount', 'tool_count');
  if (toolCountRaw !== undefined && toolCountRaw !== null) {
    const n = Number(toolCountRaw);
    if (Number.isInteger(n) && n >= 0) value.toolCount = n;
  }
  return { ok: true, value };
}

/** Naming convention for an integration's usage skill — one skill per group, so
 *  the slug is derivable and a second call can't fork a duplicate. */
export function apiSkillSlugForGroup(groupSlug: string): string {
  return `api-${groupSlug}`;
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
        error: `url '${url}' must start with http(s):// and contain no spaces — a relative path only works when the tool joins an integration group carrying a base_url (pass group_slug, or set base_url on the group with tool_group_ensure)`,
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
