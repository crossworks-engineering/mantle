/**
 * OpenAPI spec handling for OpenAPI connectors — the PURE half: parse a 3.x
 * document (JSON or YAML), resolve internal $refs under hard caps, extract the
 * operation inventory, and COMPILE selected operations into ordinary `http`
 * tool handlers + input schemas. No fetching, no DB — `openapi-sync.ts` owns
 * both sides.
 *
 * Trust model: the spec is THIRD-PARTY text. Every spec-derived string is
 * stripped of `{{secret:…}}` sequences (a hostile spec must not be able to
 * name the owner's vault refs into a template the dispatcher would resolve),
 * descriptions and schemas are size-capped, and operation/path-level `servers`
 * overrides are ignored — every compiled tool calls the group's single
 * owner-visible base URL. Auth never comes from the spec: the group's own
 * `authTemplate` is folded in by the same authoring-time inheritance
 * hand-authored http tools use.
 */

import { parse as parseYaml } from 'yaml';
import type { ToolGroupIntegration } from '@mantle/db';
import { applyIntegrationInheritance } from './integration-meta';
import type { HttpHandler } from './http-template';

/** Byte cap on a fetched spec. Stripe-class specs (~6 MB) must narrow via a
 *  trimmed mirror; the teaching error says so. */
export const OPENAPI_SPEC_MAX_BYTES = 5 * 1024 * 1024;
/** Hard cap on enabled tools per connector — every description is paid for in
 *  the prompt on every turn. A sync over the cap FAILS (never silently trims). */
export const OPENAPI_TOOL_HARD_CAP = 80;
/** Above this the sync result warns that the group is context-heavy. */
export const OPENAPI_TOOL_WARN_THRESHOLD = 30;

const TOOL_DESC_MAX_CHARS = 2_000;
/** A compiled schema past this (as JSON) is replaced with an open object —
 *  the upstream API still validates its own arguments. */
const TOOL_SCHEMA_MAX_CHARS = 30_000;
const REF_MAX_DEPTH = 8;
/** Resolved-node budget per operation — a $ref bomb degrades, never hangs. */
const REF_NODE_BUDGET = 4_000;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'] as const;
type SpecMethod = (typeof HTTP_METHODS)[number];
/** Methods the http handler enum supports (head is inventoried but not compiled). */
const HANDLER_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const SECRET_REF_STRIP = /\{\{\s*secret:/gi;
const ABS_URL_RE = /^https?:\/\/\S+$/i;

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Neutralise `{{secret:…}}` openers in third-party text so a hostile spec can
 *  never place a resolvable vault ref into a stored template or description. */
export function stripSecretRefs(s: string): string {
  return s.replace(SECRET_REF_STRIP, '{{blocked-secret:');
}

/* ────────────────────────────── parsing ─────────────────────────────── */

export type ParsedSpec =
  { ok: true; doc: Dict; format: 'json' | 'yaml' } | { ok: false; error: string };

/** Parse an OpenAPI 3.x document from raw text — JSON first, YAML fallback.
 *  Swagger 2.0 is refused with a pointer at a converter (no conversion here). */
export function parseOpenapiDocument(text: string): ParsedSpec {
  let doc: unknown;
  let format: 'json' | 'yaml' = 'json';
  try {
    doc = JSON.parse(text);
  } catch {
    try {
      doc = parseYaml(text, { maxAliasCount: 100 });
      format = 'yaml';
    } catch {
      return {
        ok: false,
        error:
          'the document is neither valid JSON nor valid YAML — check the spec URL returns the OpenAPI document itself, not an HTML page around it',
      };
    }
  }
  if (!isDict(doc)) {
    return { ok: false, error: 'the document parsed but is not an object — not an OpenAPI spec' };
  }
  if (typeof doc.swagger === 'string') {
    return {
      ok: false,
      error: `this is a Swagger ${doc.swagger} document — only OpenAPI 3.x is supported; convert it first (e.g. with swagger2openapi) and point the connector at the converted spec`,
    };
  }
  const version = typeof doc.openapi === 'string' ? doc.openapi : '';
  if (!version.startsWith('3.')) {
    return {
      ok: false,
      error: `missing or unsupported 'openapi' version field ('${version}') — the document must declare OpenAPI 3.x`,
    };
  }
  if (!isDict(doc.paths)) {
    return { ok: false, error: "the spec has no 'paths' object — nothing to materialise" };
  }
  return { ok: true, doc, format };
}

/* ─────────────────────────── $ref resolution ────────────────────────── */

type RefCtx = {
  doc: Dict;
  budget: number;
  warnings: Set<string>;
};

function lookupPointer(doc: Dict, ref: string): unknown {
  const path = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node: unknown = doc;
  for (const part of path) {
    if (!isDict(node) || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Deep-copy `node` with internal `#/…` $refs inlined. External/remote refs,
 * cycles, depth past REF_MAX_DEPTH, and budget exhaustion all degrade to an
 * open object (`{}`) with a warning — the upstream server stays the final
 * validator of its own arguments.
 */
export function resolveNode(
  ctx: RefCtx,
  node: unknown,
  depth = 0,
  seenRefs: ReadonlySet<string> = new Set(),
): unknown {
  if (ctx.budget-- <= 0) {
    ctx.warnings.add('spec is too deeply nested — some schemas degraded to open objects');
    return {};
  }
  if (Array.isArray(node)) return node.map((v) => resolveNode(ctx, v, depth + 1, seenRefs));
  if (!isDict(node)) return typeof node === 'string' ? stripSecretRefs(node) : node;

  const ref = node.$ref;
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/')) {
      ctx.warnings.add(
        `external $ref '${ref.slice(0, 120)}' not followed (internal refs only) — schema degraded to an open object`,
      );
      return {};
    }
    if (seenRefs.has(ref) || depth >= REF_MAX_DEPTH) {
      // Cyclic or over-deep — the open object keeps the tool usable.
      return {};
    }
    const target = lookupPointer(ctx.doc, ref);
    if (target === undefined) {
      ctx.warnings.add(`$ref '${ref}' points at nothing — schema degraded to an open object`);
      return {};
    }
    return resolveNode(ctx, target, depth + 1, new Set([...seenRefs, ref]));
  }

  const out: Dict = {};
  for (const [k, v] of Object.entries(node)) {
    out[stripSecretRefs(k)] = resolveNode(ctx, v, depth + 1, seenRefs);
  }
  return out;
}

function cappedSchema(schema: Dict): Dict {
  try {
    if (JSON.stringify(schema).length <= TOOL_SCHEMA_MAX_CHARS) return schema;
  } catch {
    /* unserialisable — fall through */
  }
  return { type: 'object', additionalProperties: true };
}

/* ───────────────────────────── inventory ────────────────────────────── */

/** Operation identity: operationId when present, else 'method /path'
 *  (lowercase method). Keys the sync — a slug-convention change can't fork rows. */
export function operationKeyOf(method: string, path: string, operationId?: string): string {
  const id = operationId?.trim();
  return id ? id : `${method.toLowerCase()} ${path}`;
}

export type SpecOperation = {
  op: string;
  method: SpecMethod;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  raw: Dict;
  pathItem: Dict;
};

function listOperations(doc: Dict): SpecOperation[] {
  const out: SpecOperation[] = [];
  for (const [path, itemRaw] of Object.entries(doc.paths as Dict)) {
    if (!isDict(itemRaw)) continue;
    for (const method of HTTP_METHODS) {
      const opRaw = itemRaw[method];
      if (!isDict(opRaw)) continue;
      const operationId = typeof opRaw.operationId === 'string' ? opRaw.operationId : undefined;
      out.push({
        op: operationKeyOf(method, path, operationId),
        method,
        path,
        ...(operationId ? { operationId } : {}),
        ...(typeof opRaw.summary === 'string'
          ? { summary: stripSecretRefs(opRaw.summary).slice(0, 300) }
          : {}),
        tags: Array.isArray(opRaw.tags) ? opRaw.tags.filter((t) => typeof t === 'string') : [],
        raw: opRaw,
        pathItem: itemRaw,
      });
    }
  }
  return out;
}

export type SpecInventory = {
  title: string;
  version: string;
  /** Root-level servers, absolute http(s) only, templated ones excluded. */
  servers: string[];
  securitySchemes: Array<{ name: string; type: string; in?: string; scheme?: string }>;
  tags: Array<{ name: string; count: number }>;
  operations: Array<{
    op: string;
    method: string;
    path: string;
    operationId?: string;
    summary?: string;
    tags: string[];
  }>;
};

/** The pick-list view of a spec: what the preview endpoint and the settings
 *  UI render so selection happens BEFORE anything materialises. */
export function extractInventory(doc: Dict): SpecInventory {
  const info = isDict(doc.info) ? doc.info : {};
  const servers = rootServers(doc);
  const schemes: SpecInventory['securitySchemes'] = [];
  const components = isDict(doc.components) ? doc.components : {};
  if (isDict(components.securitySchemes)) {
    for (const [name, s] of Object.entries(components.securitySchemes)) {
      if (!isDict(s)) continue;
      schemes.push({
        name: stripSecretRefs(name).slice(0, 100),
        type: typeof s.type === 'string' ? s.type : 'unknown',
        ...(typeof s.in === 'string' ? { in: s.in } : {}),
        ...(typeof s.scheme === 'string' ? { scheme: s.scheme } : {}),
      });
    }
  }
  const ops = listOperations(doc);
  const tagCounts = new Map<string, number>();
  for (const op of ops) {
    for (const t of op.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  return {
    title: typeof info.title === 'string' ? stripSecretRefs(info.title).slice(0, 200) : '',
    version: typeof info.version === 'string' ? info.version.slice(0, 60) : '',
    servers,
    securitySchemes: schemes,
    tags: [...tagCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    operations: ops.map(({ raw: _r, pathItem: _p, ...rest }) => rest),
  };
}

function rootServers(doc: Dict): string[] {
  if (!Array.isArray(doc.servers)) return [];
  const out: string[] = [];
  for (const s of doc.servers) {
    if (!isDict(s) || typeof s.url !== 'string') continue;
    const url = s.url.trim().replace(/\/+$/, '');
    if (ABS_URL_RE.test(url) && !url.includes('{')) out.push(url);
  }
  return out;
}

/* ───────────────────────────── selection ────────────────────────────── */

export type OpenapiSelection = { tags?: string[]; operations?: string[] };

/** True when the operation is in the effective set: union of tag matches and
 *  explicit identities (operationId, or 'method /path' with any method case).
 *  No selection at all means everything. */
export function operationSelected(
  op: Pick<SpecOperation, 'op' | 'method' | 'path' | 'operationId' | 'tags'>,
  selection: OpenapiSelection | undefined,
): boolean {
  const tags = selection?.tags ?? [];
  const operations = selection?.operations ?? [];
  if (tags.length === 0 && operations.length === 0) return true;
  if (tags.length > 0 && op.tags.some((t) => tags.includes(t))) return true;
  const methodPath = `${op.method} ${op.path}`;
  return operations.some((entry) => {
    if (entry === op.operationId || entry === op.op) return true;
    // 'GET /pets/{id}' style: method case-insensitive, path exact.
    const space = entry.indexOf(' ');
    if (space < 0) return false;
    return `${entry.slice(0, space).toLowerCase()}${entry.slice(space)}` === methodPath;
  });
}

/* ───────────────────────────── compiling ────────────────────────────── */

export type CompiledOperation = {
  /** Operation identity — what `handler.openapi.op` will carry. */
  op: string;
  method: string;
  path: string;
  name: string;
  description: string;
  inputSchema: Dict;
  /** The finished http handler (provenance is added by the sync). */
  handler: HttpHandler;
};

export type CompileResult =
  | {
      ok: true;
      tools: CompiledOperation[];
      warnings: string[];
      /** Operations in the spec before selection. */
      operationsTotal: number;
      /** From root `servers[0]`, when absolute and untemplated. */
      suggestedBaseUrl?: string;
      /** True when the spec declares security but the group has no authTemplate. */
      specDeclaresSecurity: boolean;
    }
  | { ok: false; error: string };

/** A `{param}` placeholder needs an identifier name; spec param names like
 *  'page[size]' get a sanitised input name while the wire name stays exact. */
function toIdent(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'param';
  if (/^[0-9]/.test(s)) s = `p_${s}`;
  return s;
}

function uniqueIdent(base: string, taken: Set<string>): string {
  let ident = base;
  let n = 2;
  while (taken.has(ident)) ident = `${base}_${n++}`;
  taken.add(ident);
  return ident;
}

type ResolvedParam = { name: string; in: string; required: boolean; schema: Dict; desc: string };

function collectParams(ctx: RefCtx, op: SpecOperation): ResolvedParam[] {
  const merged = new Map<string, ResolvedParam>();
  for (const source of [op.pathItem.parameters, op.raw.parameters]) {
    if (!Array.isArray(source)) continue;
    for (const raw of source) {
      const p = resolveNode(ctx, raw);
      if (!isDict(p) || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
      merged.set(`${p.in}:${p.name}`, {
        name: p.name,
        in: p.in,
        required: p.required === true || p.in === 'path',
        schema: isDict(p.schema) ? p.schema : { type: 'string' },
        desc: typeof p.description === 'string' ? p.description.slice(0, 500) : '',
      });
    }
  }
  return [...merged.values()];
}

/**
 * Compile the selected operations of a parsed spec into http tools. The
 * group's integration supplies the base URL join + auth placement via the
 * same `applyIntegrationInheritance` hand-authored tools use; a missing
 * `baseUrl` is a compile error (the teaching text names the fixes).
 */
export function compileOperations(
  doc: Dict,
  args: {
    integration: ToolGroupIntegration | null;
    selection?: OpenapiSelection;
  },
): CompileResult {
  const warnings = new Set<string>();
  const all = listOperations(doc);
  const selected = all.filter((op) => operationSelected(op, args.selection));
  const servers = rootServers(doc);
  const specDeclaresSecurity =
    Array.isArray(doc.security) ||
    (isDict(doc.components) && isDict((doc.components as Dict).securitySchemes));

  // Path/operation-level servers are IGNORED: one owner-visible base URL per
  // connector. Surface the hosts so the owner can pick the right base_url.
  const overrideHosts = new Set<string>();
  for (const op of selected) {
    for (const src of [op.pathItem.servers, op.raw.servers]) {
      if (!Array.isArray(src)) continue;
      for (const s of src) {
        if (isDict(s) && typeof s.url === 'string') overrideHosts.add(s.url.slice(0, 120));
      }
    }
  }
  if (overrideHosts.size > 0) {
    warnings.add(
      `path/operation-level servers are ignored (every tool calls the group base_url); the spec names: ${[...overrideHosts].slice(0, 5).join(', ')}`,
    );
  }

  const baseUrl = args.integration?.baseUrl;
  if (selected.length > 0 && !baseUrl) {
    return {
      ok: false,
      error:
        servers.length > 0
          ? `the connector group has no base_url yet — set it (e.g. '${servers[0]}', from the spec's servers list) via the connector's PATCH or tool_group_ensure, then re-sync`
          : "the connector group has no base_url and the spec's root servers list has no usable absolute URL — set base_url on the connector to the API's host, then re-sync",
    };
  }

  const tools: CompiledOperation[] = [];
  for (const op of selected) {
    const method = op.method.toUpperCase();
    if (!HANDLER_METHODS.has(method)) {
      warnings.add(`${op.op}: method '${method}' is not supported by http tools — skipped`);
      continue;
    }
    const ctx: RefCtx = { doc, budget: REF_NODE_BUDGET, warnings };
    const params = collectParams(ctx, op);

    const skippedHeader = params.filter((p) => p.in === 'header' || p.in === 'cookie');
    if (skippedHeader.length > 0) {
      warnings.add(
        `${op.op}: header/cookie parameters are not compiled (auth belongs to the group's auth_template): ${skippedHeader
          .map((p) => p.name)
          .join(', ')}`,
      );
    }

    const taken = new Set<string>();
    const properties: Dict = {};
    const required: string[] = [];
    let path = op.path;

    for (const p of params.filter((x) => x.in === 'path')) {
      const ident = uniqueIdent(toIdent(p.name), taken);
      if (ident !== p.name) {
        // Rewrite the template so `{ident}` fills the original slot.
        path = path.split(`{${p.name}}`).join(`{${ident}}`);
      }
      properties[ident] = paramSchema(p, ident !== p.name ? p.name : undefined);
      required.push(ident);
    }

    const query: Record<string, string> = {};
    for (const p of params.filter((x) => x.in === 'query')) {
      const ident = uniqueIdent(toIdent(p.name), taken);
      query[p.name] = `{${ident}}`;
      properties[ident] = paramSchema(p, ident !== p.name ? p.name : undefined);
      if (p.required) required.push(ident);
    }

    // Request body: JSON only. Object schemas spread their properties at the
    // top level (the engine's spillover sends unconsumed input as the JSON
    // body); a collision or a non-object schema nests under a single `body`
    // property with an explicit `{body}` template instead.
    let bodyTemplate: string | undefined;
    if (isDict(op.raw.requestBody)) {
      const rb = resolveNode(ctx, op.raw.requestBody);
      if (isDict(rb) && isDict(rb.content)) {
        const mediaTypes = Object.keys(rb.content);
        const jsonKey =
          mediaTypes.find((m) => m === 'application/json') ??
          mediaTypes.find((m) => m.toLowerCase().includes('json'));
        if (!jsonKey) {
          warnings.add(
            `${op.op}: request body media type(s) ${mediaTypes.slice(0, 3).join(', ')} not supported (JSON only) — operation skipped`,
          );
          continue;
        }
        const media = rb.content[jsonKey];
        const schema =
          isDict(media) && isDict((media as Dict).schema) ? ((media as Dict).schema as Dict) : {};
        const bodyRequired = rb.required === true;
        const spreadable =
          (schema.type === 'object' || (schema.type === undefined && isDict(schema.properties))) &&
          isDict(schema.properties) &&
          Object.keys(schema.properties).every((k) => !taken.has(k));
        if (spreadable) {
          const props = schema.properties as Dict;
          const specRequired = new Set(
            Array.isArray(schema.required)
              ? schema.required.filter((r): r is string => typeof r === 'string')
              : [],
          );
          for (const [k, v] of Object.entries(props)) {
            taken.add(k);
            properties[k] = isDict(v) ? cappedSchema(v) : {};
            if (bodyRequired && specRequired.has(k)) required.push(k);
          }
        } else {
          const ident = uniqueIdent('body', taken);
          properties[ident] = cappedSchema(
            Object.keys(schema).length > 0 ? schema : { type: 'object' },
          );
          if (bodyRequired) required.push(ident);
          bodyTemplate = `{${ident}}`;
        }
      }
    }

    const inputSchema: Dict = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };

    const inherited = applyIntegrationInheritance(args.integration, {
      url: path,
      ...(Object.keys(query).length > 0 ? { query } : {}),
    });
    if (!inherited.ok) return { ok: false, error: inherited.error };
    if (inherited.inherited.overridden.length > 0) {
      warnings.add(
        `${op.op}: spec parameter(s) ${inherited.inherited.overridden.join(', ')} shadow the group's auth_template key(s) — the call may arrive unauthenticated`,
      );
    }

    const summary = typeof op.raw.summary === 'string' ? op.raw.summary : '';
    const descText = typeof op.raw.description === 'string' ? op.raw.description : '';
    const description =
      stripSecretRefs([summary.trim(), descText.trim()].filter(Boolean).join('. ')).slice(
        0,
        TOOL_DESC_MAX_CHARS,
      ) || `${method} ${op.path}`;

    tools.push({
      op: op.op,
      method,
      path: op.path,
      name: op.operationId ?? `${method} ${op.path}`,
      description,
      inputSchema: cappedSchema(inputSchema),
      handler: {
        kind: 'http',
        url: inherited.url,
        method: method as HttpHandler['method'],
        ...(inherited.headers ? { headers: inherited.headers } : {}),
        ...(inherited.query ? { query: inherited.query } : {}),
        ...(bodyTemplate !== undefined ? { body: bodyTemplate } : {}),
      },
    });
  }

  return {
    ok: true,
    tools,
    warnings: [...warnings],
    operationsTotal: all.length,
    ...(servers[0] ? { suggestedBaseUrl: servers[0] } : {}),
    specDeclaresSecurity,
  };
}

function paramSchema(p: ResolvedParam, wireName: string | undefined): Dict {
  const schema = cappedSchema(p.schema);
  const notes: string[] = [];
  if (p.desc) notes.push(stripSecretRefs(p.desc));
  if (wireName) notes.push(`sent to the API as '${wireName}'`);
  return {
    ...schema,
    ...(notes.length > 0 ? { description: notes.join('; ').slice(0, 600) } : {}),
  };
}
