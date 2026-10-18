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
 * Since A5 step 4 the one gate names the home (step 6, THE create-home
 * intent @mantle/db createHomeIntent, by the connection's rule:
 * gate-policy.ts mcpCreateHomeRule). What is here is the surface's own
 * shape: the `workspace` argument a create advertises and takes
 * (withWorkspaceArg), and the line a create's reply gains (withLanding,
 * run in the call's scope by gated-tools.ts, over @mantle/db landedIn).
 * Nothing here grants: it only names a place, and the database's create
 * checks still run.
 */
import { landedIn } from '@mantle/db';
import { UUID_RE } from '@mantle/std';

/*
 * The create tools that make an item of a workspace kind take `workspace`
 * and name where the item landed: their policy says `creates` (one rule for
 * MCP and assistant turns, A0 fix round 2). The create tools whose kind
 * lives in the Admin workspace only (a contact, a journal entry, a saved
 * place: mantle_kind_class 'admin_only') declare scope `admin-kind`: a user
 * outside Admin is refused them (W7b fix round 1, H2): not listed (gate
 * step 5), and the database's create home refuses the row (every call of
 * such a user runs under its private workspace). A5 step 6a deleted the
 * MCP_CREATE_TOOL_SLUGS and ADMIN_KIND_CREATE_TOOL_SLUGS views.
 */

/** The refusal of an Admin-only kind's create outside Admin: the one
 *  mapper's words (@mantle/std access-error.ts, arch A3c), gate step 5. */
export { ADMIN_KIND_CREATE_ERROR } from '@mantle/std';

/** The refusal of a create by a user outside Admin who has no private
 *  workspace (W7b fix round 2): an item it made would have no home. Said by
 *  the gate's step 6 (mcpCreateHomeRule) rather than left to the
 *  database's refusal. */
export const NO_WORKSPACE_CREATE_ERROR =
  'You are not in any workspace yet, so there is nowhere to put a new item. Ask an admin of this brain to add you to a workspace, then try again.';

/** The argument every create tool takes. */
export const WORKSPACE_ARG = 'workspace';

const WORKSPACE_ARG_SCHEMA = {
  type: 'string',
  description:
    'Optional: the id or name of a workspace you moderate to put the new item in (see workspaces_list). Without it the item lands in the folder’s workspace, else in your own private one; the reply says where.',
} as const;

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

type Reply = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/** `reply` with the landing workspace named: in the JSON object it carries
 *  (`landedIn`), or as one more line. */
export async function withLanding(reply: unknown, since: Date): Promise<unknown> {
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
