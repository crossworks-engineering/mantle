/**
 * Where an MCP create lands (workspaces W7b, plan 7.4; the owner's answer 3
 * of 2026-10-11). One MCP surface for every login: a create tool takes an
 * optional `workspace` (the id or name of a workspace the caller moderates)
 * and, without one, follows the W6b route rule (mantle_default_home): the
 * folder's workspace when the item is made in a folder the caller may edit,
 * else the caller's private workspace; for a user of the Admin workspace,
 * the folder's workspace else Admin, as before. Every create reply then
 * names the workspace the item landed in (`landedIn`).
 *
 * The wrapper sits between the scope (owner-scope.ts: each call already runs
 * in the login's scope, gated) and the tool: it reads `workspace`, asks THE
 * create-home intent (@mantle/db createHomeIntent, arch A3c: the one
 * function the web routes and assistant turns ask too) where the create
 * lands (refused unless the caller moderates the workspace it names), and
 * runs the tool under withCreateHome, which the system transactions of the
 * create set as mantle.create_ws / mantle.private_ws. Nothing here grants:
 * it only names a place, and the database's create checks still run.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import {
  createHomeIntent,
  db,
  nodes,
  withCreateHome,
  workspaces,
  type CreateHome,
} from '@mantle/db';
import { ADMIN_KIND_CREATE_ERROR } from '@mantle/std';
import { CREATE_TOOL_SLUGS } from '@mantle/tools';

/**
 * The create tools that make an item of a workspace kind: they take
 * `workspace` and name where the item landed. One list for MCP and
 * assistant turns (A0 fix round 2): @mantle/tools CREATE_TOOL_SLUGS.
 */
export const MCP_CREATE_TOOL_SLUGS: ReadonlySet<string> = CREATE_TOOL_SLUGS;

/**
 * The create tools whose kind lives in the Admin workspace only (a contact,
 * a journal entry, a saved place: mantle_kind_class 'admin_only'). A user
 * outside Admin is refused them (W7b fix round 1, H2): not listed, refused
 * here before the tool runs, and the database's create home refuses the row
 * (every call of such a user runs under its private workspace).
 */
export const ADMIN_KIND_CREATE_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'contact_create',
  'journal_create',
  'location_save',
]);

/** The refusal of an Admin-only kind's create outside Admin: the one
 *  mapper's words (@mantle/std access-error.ts, arch A3c). */
export { ADMIN_KIND_CREATE_ERROR } from '@mantle/std';

/** The refusal of a create by a user outside Admin who is in no workspace
 *  (W7b fix round 2): it has no private workspace, so an item it made would
 *  have no home. Said here rather than left to the database's refusal. */
export const NO_WORKSPACE_CREATE_ERROR =
  'You are not in any workspace yet, so there is nowhere to put a new item. Ask an admin of this brain to add you to a workspace, then try again.';

/** The argument every create tool takes. */
export const WORKSPACE_ARG = 'workspace';

const WORKSPACE_ARG_SCHEMA = {
  type: 'string',
  description:
    'Optional: the id or name of a workspace you moderate to put the new item in (see workspaces_list). Without it the item lands in the folder’s workspace, else in your own private one; the reply says where.',
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Standard Schema a registered tool's `inputSchema` is (tool-input.ts). */
type StandardLike = {
  '~standard': {
    version: number;
    vendor: string;
    validate: (value: unknown) => unknown;
    jsonSchema?: {
      input: (o?: unknown) => Record<string, unknown>;
      output: (o?: unknown) => Record<string, unknown>;
    };
  };
};

type ValidateResult = { value?: unknown; issues?: readonly unknown[] };

/** `schema` with an optional `workspace` string: validated here, the rest by
 *  the tool's own schema, and advertised in its JSON Schema. */
export function withWorkspaceArg(schema: unknown): unknown {
  const std = (schema as StandardLike | null)?.['~standard'];
  if (!std || typeof std.validate !== 'function' || !std.jsonSchema) return schema;
  const advertised = (o?: unknown) => {
    const base = std.jsonSchema!.input(o);
    const props = (base.properties ?? {}) as Record<string, unknown>;
    return { ...base, properties: { ...props, [WORKSPACE_ARG]: WORKSPACE_ARG_SCHEMA } };
  };
  const validate = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return std.validate(value);
    const { [WORKSPACE_ARG]: ws, ...rest } = value as Record<string, unknown>;
    if (ws !== undefined && ws !== null && typeof ws !== 'string') {
      return {
        issues: [{ message: 'workspace must be a workspace id or name', path: [WORKSPACE_ARG] }],
      };
    }
    const finish = (r: ValidateResult): ValidateResult =>
      r.issues || ws === undefined || ws === null
        ? r
        : { value: { ...(r.value as Record<string, unknown>), [WORKSPACE_ARG]: ws } };
    const out = std.validate(rest) as ValidateResult | Promise<ValidateResult>;
    return out instanceof Promise ? out.then(finish) : finish(out);
  };
  return {
    '~standard': {
      ...std,
      validate,
      jsonSchema: { input: advertised, output: advertised },
    },
  };
}

/** A refusal reply. */
function refusal(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** The item ids a create's reply names: an `…id` / `…Id` field at the top
 *  or one level down (an object or a list of objects), UUIDs only. */
export function replyItemIds(value: unknown): string[] {
  const out = new Set<string>();
  const take = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /(^|_)id$|Id$/.test(k) && UUID_RE.test(v))
        out.add(v.toLowerCase());
    }
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const top = value as Record<string, unknown>;
  take(top);
  for (const v of Object.values(top)) {
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 50))
        if (x && typeof x === 'object') take(x as Record<string, unknown>);
    } else if (v && typeof v === 'object') {
      take(v as Record<string, unknown>);
    }
  }
  return [...out].slice(0, 100);
}

/** Where the items a call made (named in its reply, made since `since`)
 *  landed: their home workspaces, read in the caller's scope. */
async function landedIn(ids: string[], since: Date): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(nodes)
    .innerJoin(workspaces, eq(workspaces.id, nodes.homeWs))
    .where(
      and(inArray(nodes.id, ids), or(gte(nodes.createdAt, since), sql`${nodes.createdAt} is null`)),
    );
  const seen = new Map<string, string>();
  for (const r of rows) seen.set(r.id, r.name);
  return [...seen].map(([id, name]) => ({ id, name }));
}

type Reply = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/** `reply` with the landing workspace named: in the JSON object it carries
 *  (`landedIn`), or as one more line. */
async function withLanding(reply: unknown, since: Date): Promise<unknown> {
  const r = reply as Reply | null;
  if (!r || r.isError || !Array.isArray(r.content)) return reply;
  const first = r.content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return reply;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return reply;
  }
  let homes: { id: string; name: string }[];
  try {
    homes = await landedIn(replyItemIds(parsed), since);
  } catch (err) {
    console.warn(
      '[mcp] could not read where a create landed:',
      err instanceof Error ? err.message : err,
    );
    return reply;
  }
  if (homes.length === 0) return reply;
  const landed = homes.length === 1 ? homes[0] : homes;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const text = JSON.stringify(
      { ...(parsed as Record<string, unknown>), landedIn: landed },
      null,
      2,
    );
    return { ...r, content: [{ ...first, text }, ...r.content.slice(1)] };
  }
  const names = homes.map((h) => h.name).join(', ');
  return { ...r, content: [...r.content, { type: 'text', text: `Landed in workspace: ${names}` }] };
}

/** Whether a create home names a place (a workspace asked, or the private
 *  fallback): one that names neither leaves the database's own default. */
function homeNamed(home: CreateHome): boolean {
  return home.createWs !== null || home.privateWs !== null;
}

/** What the wrapper needs of the connection. */
export type CreateHomeOpts = {
  /** The login of the connection. */
  loginId: string;
  /** The login's private workspace when its scope does not hold Admin (the
   *  route rule's fallback), else null: an Admin user's create without a
   *  `workspace` lands as before (the folder's, else Admin). */
  privateWs: string | null;
  /** The login is outside Admin and in no workspace (so `privateWs` is
   *  null): every create tool is refused with NO_WORKSPACE_CREATE_ERROR. */
  noHome?: boolean;
};

/**
 * `server`, with every create tool registered on it from here on taking
 * `workspace` and naming where its item landed (see the module comment).
 * Registered UNDER the scope wrapper (owner-scope.ts), so each call runs in
 * the login's scope, already gated.
 *
 * For a user outside Admin (`privateWs` set) EVERY call runs under its
 * private workspace (W7b fix round 1, H2), not only the listed creates: an
 * item any tool makes lands by the route rule, never in Admin, and the
 * database refuses an Admin-only kind outright. Its Admin-only creates are
 * refused here first, with a reply that says why. A user outside Admin in
 * no workspace (`noHome`) has no private workspace: each of its creates is
 * refused here, with a reply that says what to do.
 */
export function createHomeServer(server: McpServer, opts: CreateHomeOpts): McpServer {
  const privateWs = opts.privateWs;
  const noHome = opts.noHome === true && !privateWs;
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') {
        const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown;
        return (name: unknown, config: unknown, cb: unknown) => {
          if (typeof name !== 'string' || typeof cb !== 'function') {
            return fn.call(target, name, config, cb);
          }
          if (
            noHome &&
            (MCP_CREATE_TOOL_SLUGS.has(name) || ADMIN_KIND_CREATE_TOOL_SLUGS.has(name))
          ) {
            return fn.call(target, name, config, async () =>
              refusal(
                ADMIN_KIND_CREATE_TOOL_SLUGS.has(name)
                  ? ADMIN_KIND_CREATE_ERROR
                  : NO_WORKSPACE_CREATE_ERROR,
              ),
            );
          }
          if (!MCP_CREATE_TOOL_SLUGS.has(name)) {
            if (!privateWs) return fn.call(target, name, config, cb);
            const plain = cb as (args: unknown, extra: unknown) => Promise<unknown>;
            return fn.call(target, name, config, async (args: unknown, extra: unknown) => {
              if (ADMIN_KIND_CREATE_TOOL_SLUGS.has(name)) return refusal(ADMIN_KIND_CREATE_ERROR);
              // The same intent, nothing asked: the private fallback.
              const home = await createHomeIntent(opts.loginId, null, { privateWs });
              if ('refused' in home) return refusal(home.message);
              return withCreateHome(home, () => plain(args, extra));
            });
          }
          const handler = cb as (args: unknown, extra: unknown) => Promise<unknown>;
          const cfg = (config ?? {}) as { inputSchema?: unknown };
          const wrapped = { ...cfg, inputSchema: withWorkspaceArg(cfg.inputSchema) };
          return fn.call(target, name, wrapped, async (args: unknown, extra: unknown) => {
            const input = { ...((args ?? {}) as Record<string, unknown>) };
            const asked = input[WORKSPACE_ARG];
            delete input[WORKSPACE_ARG];
            // THE create-home intent (arch A3c), with the fallback this
            // connection resolved when it connected.
            const home = await createHomeIntent(
              opts.loginId,
              { from: 'argument', workspace: asked },
              { privateWs },
            );
            if ('refused' in home) return refusal(home.message);
            const since = new Date(Date.now() - 1000);
            const run = () => handler(input, extra);
            const reply = homeNamed(home) ? await withCreateHome(home, run) : await run();
            return withLanding(reply, since);
          });
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
