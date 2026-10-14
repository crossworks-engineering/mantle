/**
 * Tool-call dispatcher. Takes a `tools` row (or just a slug) and an
 * input object; routes to the right handler kind; returns
 * { ok, output } or { ok: false, error }.
 *
 * `builtin` looks up the registered TS function. `http` issues a fetch
 * (redirects followed manually so secrets never cross origin — see safeFetch).
 * `shell` runs an operator-authored command; agents can't author or edit shell
 * tools, and console/agent runs go through the same `requiresConfirm` gate.
 */

import { and, eq } from 'drizzle-orm';
import {
  asSystem,
  db,
  enterCall,
  lowerLevel,
  toolGroups,
  withCreateHome,
  type Tool,
  type ToolHandler,
  type ViewerLevel,
} from '@mantle/db';
import { currentWorkspaceScope, currentScope } from '@mantle/db/viewer';
import {
  connectorResources,
  connectorToolPolicy,
  LINK_NO_CONNECTORS,
  loginConnectorRefused,
} from './external-access';
import { NO_RUNTIME_POLICY_ERROR, runtimeToolPolicy } from './runtime-policy';
import { getApiKey } from '@mantle/api-keys';
import { builtinRowSlugError, getBuiltin, getBuiltinHandler } from './registry';
import { checkToolPreconditions } from './preconditions';
import {
  applyInputDefaults,
  buildHttpRequest,
  collectOauthRefs,
  collectSecretRefs,
  oauthKey,
  refKey,
  scrubSecrets,
} from './http-template';
import { getClientCredentialsToken } from './oauth2-client-credentials';
import { safeFetch } from './safe-fetch';
import {
  classifyRecipeStepTool,
  MAX_RECIPE_DEPTH,
  recipeVerdictReason,
  resolveTemplateValue,
  type RecipeScope,
} from './recipe';
import { sanitizedEnv } from './sanitized-env';
import { mcpCallRemoteTool } from './mcp-client';
import { isMcpManagedSecretService } from './mcp-oauth';
import { UNTRUSTED_CONTENT_TOOL_SLUGS } from './untrusted';
import type { ToolHandlerContext, ToolHandlerResult } from './types';
import { registerToolDispatcher } from './dispatch-bridge';
import { isOwnerSurface, OWNER_ONLY_ERROR } from './surface';
import { adminToolGate, runGated } from './admin-gate';
import { toolItemWriteRefusal } from './item-write-gate';
import { turnCreateHome } from './turn-create-home';
import { builtinToolGatePolicy, builtinToolRef, mcpBuiltinToolRef } from './tool-gate-policy';
import {
  currentToolCaller,
  gateCallerFor,
  mcpVia,
  nestedToolCaller,
  withToolCaller,
  type ToolCaller,
} from './gate-callers';
import { maskToolDatabaseErrors } from './tool-error-mask';
import { mcpPairing, secretRefsRunRefusal, vaultPairRunRefusal } from './secret-ref-gate';

// Same-package callers that must not import this module (it imports the
// registry, which imports every builtin) reach dispatchTool through the bridge.
import { resolveTool, resolveTools } from './resolve';
export { resolveTool, resolveTools };
import { errorMessage } from '@mantle/std';

const HTTP_TIMEOUT_MS_DEFAULT = 15_000;

// The adminOnly list and the Admin gate live in admin-gate.ts (W7a: the
// Admin MCP surface gates its calls with them too).
export { ADMIN_ONLY_ERROR, ADMIN_ONLY_TOOL_SLUGS } from './admin-gate';

/**
 * Run one tool call. An entry that names its caller (ctx.caller: an
 * assistant turn, a run item, a pending approval; gate-callers.ts), and a
 * call nested in one (a recipe's step, a tool a handler dispatches), runs
 * through the one gate (@mantle/db enterCall, workspaces arch A5 step 3a):
 * the tool's declared policy, the narrowers, the Admin step, the pre-run
 * checks, the create home, then the handler. The owner MCP surface names
 * its connection's whole caller (mcpToolCaller, A5 step 4) and the /api/v1
 * builtin routes theirs (apiV1Caller). The entries that do not name one yet
 * (the app tool brokers and the dev console: A5 step 3b) run the checks
 * below in dispatch, as before (dispatch-entries.test.ts pins which).
 */
export async function dispatchTool(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  /** Internal: recipe-in-recipe nesting depth. Callers leave this 0. */
  depth = 0,
): Promise<ToolHandlerResult> {
  const caller = ctx.caller ?? currentToolCaller();
  if (caller) {
    // What a call nested in this one reuses (a recipe's steps, a tool a
    // handler dispatches): the same caller, less an MCP call's own parts.
    const nested = nestedToolCaller(caller);
    const call = { ...ctx, caller: nested };
    const run = () => withToolCaller(nested, () => dispatchGated(caller, tool, input, call, depth));
    // An MCP connection never reads a database error's text (W3): the one
    // masking (tool-error-mask.ts). A turn masks in the tool loop.
    return mcpVia(caller) ? maskToolDatabaseErrors(`mcp ${tool.slug}`, run) : run();
  }
  return dispatchUngated(tool, input, ctx, depth);
}

/** Whether `caller` is a key or a peer: it never confirms for the owner. */
function keyOrPeer(caller: ToolCaller): boolean {
  return caller.via === 'key' || caller.via === 'peer';
}

/**
 * One call through the gate (A5 step 3a; see dispatchTool). What it answers
 * is what dispatch answered before, word for word (dispatch-parity.test.ts):
 * a refusal of the gate is its tool text, and the item pre-check's own
 * words; a handler that throws is its message.
 */
async function dispatchGated(
  caller: ToolCaller,
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  depth: number,
): Promise<ToolHandlerResult> {
  const h = tool.handler as ToolHandler;
  // An MCP call (A5 step 4): an error a step or the handler throws goes to
  // the surface, which answers it as it always has (a database error in
  // the one mapper's words, any other as the SDK says it), never as text.
  const mcp = caller.entry === 'mcp';
  // So does a /api/v1 route's (A5 step 4 fix round 1, M1): app.onError
  // answers it as before the route ran through here (an edit check refusal
  // its 403 or 404, any other the opaque 500), never a 400 with its text.
  const rethrows = mcp || caller.entry === 'api-v1';
  // A key or a peer acting as the owner never confirms for the owner: a
  // level change a builtin would cause is refused instead of confirmed by
  // its own flag (the owner MCP surface's rule; a connector's row takes
  // the arguments its schema lists, as before).
  let args = input;
  if (h.kind === 'builtin' && keyOrPeer(caller) && 'confirm' in input) {
    args = { ...input };
    delete args.confirm;
  }
  if (h.kind === 'builtin') {
    const fn = getBuiltinHandler(h.ref);
    if (!fn) {
      return {
        ok: false,
        error: `builtin handler '${h.ref}' not registered in this process`,
      };
    }
    // A builtin row named with another builtin's slug runs nothing (A5).
    const clash = builtinRowSlugError(tool.slug, h.ref);
    if (clash) return { ok: false, error: clash };
    // Owner-only tools refuse anyone but the owner before any other work
    // (client logins C4): a team or MISSING surface is not the owner.
    if (getBuiltin(h.ref)?.ownerOnly && !isOwnerSurface(ctx.surface)) {
      return { ok: false, error: OWNER_ONLY_ERROR };
    }
    const toolRef = builtinToolRef(h.ref, tool.slug);
    const policy = builtinToolGatePolicy(toolRef);
    // An MCP call is called as the surface lists it (listing equals
    // calling): its `mcp-tool` policy, by the name it is listed under.
    const ref = mcp ? mcpBuiltinToolRef(tool.slug, h.ref) : toolRef;
    let thrown: { err: unknown } | null = null;
    try {
      const res = await enterCall(
        await gateCallerFor(caller, policy, true),
        ref,
        async (): Promise<ToolHandlerResult | null> => {
          try {
            const run = () => fn(args, ctx);
            // An AREA_SYSTEM_TOOLS tool runs whole on the system pool after
            // its area check, in a workspace scope (W7a fix round 1, H1).
            const whole = policy?.fields?.systemWhole === true && !!currentWorkspaceScope();
            return await runGated({ system: whole }, run);
          } catch (err) {
            if (!rethrows) return { ok: false, error: errorMessage(err) };
            thrown = { err };
            return null;
          }
        },
        {
          args,
          ...(mcp ? { ask: caller.ask ?? null } : {}),
          context: {
            ownerId: ctx.ownerId,
            ...(ctx.surface ? { surface: ctx.surface } : {}),
            ...(rethrows ? { throws: true } : {}),
          },
        },
      );
      if (thrown) throw (thrown as { err: unknown }).err;
      if (!res.ok) return { ok: false, error: res.refusal.toolText };
      return res.value ?? { ok: false, error: 'the tool gave no result' };
    } catch (err) {
      if (rethrows) throw err;
      return { ok: false, error: errorMessage(err) };
    }
  }
  // No runtime tool runs without a policy (arch A3c, plan section 8): one
  // function per row type gives it (runtime-policy.ts), and the gate's step
  // 3 refuses a row with none, in the words dispatch said before.
  const ref = Object.freeze({ kind: 'runtime-tool', name: tool.slug, row: tool });
  let thrown: { err: unknown } | null = null;
  const res = await enterCall(
    await gateCallerFor(caller, runtimeToolPolicy(tool), false),
    ref,
    async (): Promise<ToolHandlerResult | null> => {
      try {
        return await dispatchRuntime(h, tool, args, ctx, depth);
      } catch (err) {
        // Thrown on, past the gate's mapper, as before step 3a.
        thrown = { err };
        return null;
      }
    },
    // The call's arguments, for the surface's own check (an MCP connector
    // row's, A5 step 4); the registered pre-run checks read no runtime row.
    { args, context: { ownerId: ctx.ownerId, ...(ctx.surface ? { surface: ctx.surface } : {}) } },
  );
  if (thrown) throw (thrown as { err: unknown }).err;
  if (!res.ok) {
    const unclassified = res.refusal.kind === 'unclassified';
    return { ok: false, error: unclassified ? NO_RUNTIME_POLICY_ERROR : res.refusal.toolText };
  }
  return res.value ?? { ok: false, error: `unknown handler kind` };
}

/** A runtime row's handler, by its kind (its policy was checked). */
function dispatchRuntime(
  h: ToolHandler,
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  depth: number,
): Promise<ToolHandlerResult> {
  if (h.kind === 'http') {
    return dispatchHttp(h, applyInputDefaults(tool.inputSchema, input), ctx, tool);
  }
  if (h.kind === 'shell') return dispatchShell(h, input, ctx);
  if (h.kind === 'recipe') return dispatchRecipe(h, input, ctx, depth);
  if (h.kind === 'mcp') return dispatchMcp(h, input, ctx, tool);
  return Promise.resolve({ ok: false, error: `unknown handler kind` });
}

/**
 * dispatchTool for an entry that names no caller yet (the app tool brokers
 * and the dev console until A5 step 3b): the checks run here, in the order
 * the gate runs them. Deleted when the last of those entries names its
 * caller.
 */
async function dispatchUngated(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  depth: number,
): Promise<ToolHandlerResult> {
  const h = tool.handler as ToolHandler;
  if (h.kind === 'builtin') {
    const fn = getBuiltinHandler(h.ref);
    if (!fn) {
      return {
        ok: false,
        error: `builtin handler '${h.ref}' not registered in this process`,
      };
    }
    // A builtin row named with another builtin's slug runs nothing (A5): a
    // check that matches the row's slug as well as its ref would read it as
    // both tools.
    const clash = builtinRowSlugError(tool.slug, h.ref);
    if (clash) return { ok: false, error: clash };
    const def = getBuiltin(h.ref);
    // Owner-only tools refuse anyone but the owner before any other work
    // (client logins C4): a team or MISSING surface is not the owner.
    if (def?.ownerOnly && !isOwnerSurface(ctx.surface)) {
      return { ok: false, error: OWNER_ONLY_ERROR };
    }
    // adminOnly (W4b, plan 5.4): an ownerOnly or adminOnly tool runs in a
    // workspace scope only when that scope holds the Admin workspace; an
    // Admin-area tool only when the scope may do that area, and then still
    // in the scope, except the system-table tools (W7a fix round 1, H1,
    // admin-gate.ts).
    const gate = await adminToolGate(tool.slug, { ref: h.ref, ownerOnly: def?.ownerOnly });
    if ('refused' in gate) return { ok: false, error: gate.refused };
    try {
      // Declared referential preconditions run first — a call aimed at a
      // missing or wrong-type node gets a uniform teaching error before any
      // handler work (see preconditions.ts).
      const pre = def?.preconditions;
      if (pre && pre.length > 0) {
        const failure = await checkToolPreconditions(pre, input, ctx.ownerId);
        if (failure) return failure;
      }
      // A write to an item checks the scope may make it (W7a fix round 1,
      // M2): the item routes' rule, asked before any write.
      const refused = await toolItemWriteRefusal(tool.slug, input, ctx.ownerId, h.ref, ctx);
      if (refused) return { ok: false, error: refused };
      // What it makes lands by the home rule, as the same login's create
      // from the web would (A0, turn-create-home.ts).
      // Any tool that is not readOnly may make an item (export_node,
      // sandbox_export and the like, not only the listed creates), so it may
      // make the login's private workspace (A0 fix round 3, M-a).
      const home = await turnCreateHome(def?.readOnly !== true);
      const run = () => runGated(gate, () => fn(input, ctx));
      return await (home ? withCreateHome(home, run) : run());
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
  // No runtime tool runs without a policy (arch A3c, plan section 8): one
  // function per row type gives it (runtime-policy.ts).
  if (!runtimeToolPolicy(tool)) return { ok: false, error: NO_RUNTIME_POLICY_ERROR };
  return dispatchRuntime(h, tool, input, ctx, depth);
}

/** Text cap on an MCP result before the normal inline/spill machinery —
 *  matches web_fetch's MAX_TEXT_CAP; the same class of egress. */
const MCP_RESULT_TEXT_CAP = 80_000;

/** The level a non-owner call runs at: the viewer scope, lowered to what its
 *  surface names (an admin-level agent serving a member is still a member's
 *  call). Null for the owner's own paths. */
function nonOwnerRunLevel(ctx: ToolHandlerContext): ViewerLevel | null {
  const s = ctx.surface;
  const bySurface: ViewerLevel | null =
    s?.kind === 'team' ? 'team' : s?.kind === 'contact' ? 'public' : null;
  // Outside a workspace scope (its callers return first inside one): system
  // work (the level scope went in W8c).
  const viewer: ViewerLevel = currentScope().kind === 'system' ? 'admin' : 'public';
  if (!bySurface) return viewer === 'admin' ? null : viewer;
  try {
    return lowerLevel(viewer, bySurface);
  } catch {
    // client with public: no common level, nothing passes.
    return 'public';
  }
}

/**
 * The arguments of a call that the tool's stored input schema does not
 * declare (access matrix T6). A read-only mark is for the schema the admin
 * looked at, but the remote server may add a parameter (one that writes)
 * long before the next sync rewrites the row and voids the mark. Below the
 * owner a marked tool takes only the arguments it was marked with: an open
 * schema (`additionalProperties`) counts as closed, and one level down an
 * object argument takes only the keys its schema lists (audit B2). An
 * undeclared key comes back as `name`, a nested one as `name.key`.
 */
export function undeclaredToolArgs(schema: unknown, input: Record<string, unknown>): string[] {
  const propsOf = (x: unknown): Record<string, unknown> | null => {
    const p = x && typeof x === 'object' ? (x as { properties?: unknown }).properties : null;
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  };
  const props = propsOf(schema) ?? {};
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(props, k)) {
      out.push(k);
      continue;
    }
    const inner = propsOf(props[k]);
    if (!inner || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
      if (iv !== undefined && !Object.prototype.hasOwnProperty.call(inner, ik))
        out.push(`${k}.${ik}`);
    }
  }
  return out;
}

/** What a connector tool's read-only mark refuses (one copy for the scope
 *  rule and the rule below the owner, arch A3c): a stale mark, or a marked
 *  tool called with an input it was not marked with. Null for a write. */
function connectorMarkRefusal(
  mark: 'read' | 'write' | 'stale',
  tool: Tool,
  input: Record<string, unknown>,
): string | null {
  if (mark === 'stale') {
    return 'This connector tool changed after an admin marked it read-only; it runs again once an admin marks it again.';
  }
  if (mark !== 'read') return null;
  const extra = undeclaredToolArgs(tool.inputSchema, input);
  if (extra.length === 0) return null;
  return `This connector tool was marked read-only with the inputs it had then, and ${extra.map((k) => `'${k}'`).join(', ')} is not one of them. Call it with only the inputs it lists, or ask an admin to sync the connector and mark the tool again.`;
}

/** Why a connector call is refused in a workspace turn scope (W4b, plan
 *  section 6), or null: the connector must be a resource of the scope's
 *  workspace; a tool not marked read-only needs that resource's Write on AND
 *  the asking login a Moderator there; a stale mark is refused. */
async function connectorScopeRefused(
  ctx: ToolHandlerContext,
  groupSlug: string,
  tool: Tool,
  input: Record<string, unknown>,
): Promise<string | null> {
  const scope = currentWorkspaceScope();
  if (!scope) return null;
  // A link scope holds no workspace (W5b2): no connector reaches it.
  if (scope.kind === 'link') return LINK_NO_CONNECTORS;
  const held = await connectorResources(ctx.ownerId, groupSlug, scope.ws);
  if (held.length === 0) {
    return "This connector is not one of this workspace's resources, so its tools do not run here.";
  }
  const { fields } = connectorToolPolicy(tool);
  const marked = connectorMarkRefusal(fields.mark, tool, input);
  if (marked !== null || fields.mark === 'read') return marked;
  const mod = new Set(scope.modWs);
  if (!held.some((r) => r.write && mod.has(r.workspaceId))) {
    return 'This connector tool can change data: it needs the connector’s Write switched on in this workspace, and the person asking to be a Moderator here.';
  }
  return null;
}

/**
 * Why a connector call is refused for a non-owner run outside a workspace
 * scope, or null (W5b2). The connector's level decides nothing (it only
 * says which agents may hold the group): the workspaces that hold the
 * connector do. A call on a login's surface (a member's)
 * takes the login's workspace rule (loginConnectorRefused); a contact link
 * holds no workspace, so it reaches no connector; any other non-owner run
 * names no login to check, so it is refused too (fails closed).
 */
async function connectorCallRefused(
  ctx: ToolHandlerContext,
  groupSlug: string,
  tool: Tool,
  input: Record<string, unknown>,
): Promise<string | null> {
  // A workspace scope: connectorScopeRefused decides.
  if (currentWorkspaceScope()) return null;
  const run = nonOwnerRunLevel(ctx);
  if (!run) return null;
  const { mark } = connectorToolPolicy(tool).fields;
  if (mark === 'stale') return connectorMarkRefusal(mark, tool, input);
  if (run === 'public' && mark === 'write') {
    return 'On a shared link only connector tools an admin marked read-only run; this one can change data.';
  }
  const marked = connectorMarkRefusal(mark, tool, input);
  if (marked !== null) return marked;
  const s = ctx.surface;
  if (s?.kind === 'contact') return LINK_NO_CONNECTORS;
  if (s?.kind === 'team' && s.loginId) {
    return loginConnectorRefused(ctx.ownerId, s.loginId, groupSlug, mark === 'write');
  }
  return 'This connector tool runs below the owner only for a signed-in user of a workspace that holds the connector.';
}

/**
 * Run a connector tool against its external MCP server. The connector config
 * lives on the group's `integration.mcp` (resolved per call so a config edit
 * takes effect immediately); the client manager caches the connection. Every
 * result is third-party authored → capped, secret-scrubbed, `untrusted`.
 */
async function dispatchMcp(
  h: Extract<ToolHandler, { kind: 'mcp' }>,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  tool: Tool,
): Promise<ToolHandlerResult> {
  // asSystem: the connector's binding is infrastructure, like its keys. A
  // client-level call (an External access tool in a client app) reads tool
  // groups at client level only, so the connector group, whatever its level,
  // would look missing. The caller learns nothing from it but the result.
  const [group] = await asSystem(
    () =>
      db
        .select()
        .from(toolGroups)
        .where(and(eq(toolGroups.ownerId, ctx.ownerId), eq(toolGroups.slug, h.group)))
        .limit(1),
    'connector-binding',
  );
  const mcp = group?.integration?.mcp;
  if (!group || !mcp) {
    return {
      ok: false,
      error: `MCP connector group '${h.group}' no longer exists or lost its server binding — recreate the connector (or re-run its sync) before calling this tool`,
    };
  }
  if (!group.enabled) {
    return {
      ok: false,
      error: `MCP connector '${h.group}' is disabled — ask the owner to enable it under Settings → Tool groups`,
    };
  }
  // The workspaces that hold the connector and the read-only mark hold on
  // EVERY path below the owner (team apps M2 audit, low 6; W5b2): a chat
  // turn whose agent holds the tool through another group, an app run, a
  // login's MCP. A public run (a public agent) only ever reads (Jason,
  // 2026-10-08), so an unmarked tool is refused there.
  const refused =
    (await connectorCallRefused(ctx, group.slug, tool, input)) ??
    (await connectorScopeRefused(ctx, group.slug, tool, input)) ??
    // The connector's key goes to its URL only while the login that paired
    // them holds the keys area (W7a fix round 4, secret-ref-gate.ts).
    (await vaultPairRunRefusal(group.configuredBy, ctx.ownerId, !!mcpPairing(mcp).key));
  if (refused) return { ok: false, error: refused };
  try {
    // asSystem: the remote call reads and, for an OAuth connector, refreshes
    // the connector's OWN credentials (api_keys), which a limited role may
    // not write. A shared app's call to a tool with External access
    // (external-access.ts) runs under the team role, and the token refresh failed
    // there. Nothing of the brain's content is read here: the result comes
    // from the remote server, and the call stays on the caller's surface.
    const res = await asSystem(
      () => mcpCallRemoteTool(ctx.ownerId, h.group, mcp, h.toolName, input),
      'connector-call',
    );
    const scrub = (s: string) => scrubSecrets(s, res.secrets);
    let text = scrub(res.text);
    const truncated = text.length > MCP_RESULT_TEXT_CAP;
    if (truncated) text = text.slice(0, MCP_RESULT_TEXT_CAP);
    ctx.step?.setMeta({
      mcp_group: h.group,
      mcp_tool: h.toolName,
      length: res.text.length,
      ...(truncated ? { truncated: true } : {}),
    });
    if (res.isError) {
      return { ok: false, error: `remote MCP tool '${h.toolName}' failed: ${text.slice(0, 2000)}` };
    }
    // Prefer the server's structured result (scrubbed via its JSON text) and
    // fall back to text, JSON-parsed when possible — mirrors dispatchHttp.
    let output: unknown;
    if (res.structured !== undefined) {
      try {
        output = JSON.parse(scrub(JSON.stringify(res.structured)).slice(0, MCP_RESULT_TEXT_CAP));
      } catch {
        output = text;
      }
    } else {
      try {
        output = JSON.parse(text);
      } catch {
        output = truncated ? `${text}\n[truncated at ${MCP_RESULT_TEXT_CAP} chars]` : text;
      }
    }
    return { ok: true, output, untrusted: true };
  } catch (err) {
    const msg = errorMessage(err);
    return { ok: false, error: msg.slice(0, 2000) };
  }
}

/**
 * Run a recipe handler: each step calls an existing tool, with `{param}` /
 * `$ref` templating threading the recipe input and prior step outputs between
 * calls — all server-side, so values never cross the LLM. The recipe's result
 * is its `output` template (when set) or the last step's output.
 *
 * The safety envelope is re-checked here (not just at authoring time): a step
 * may not call a shell tool, a confirm-gated tool, or a forbidden privilege
 * builtin even if the recipe row was authored before such a tool existed or
 * was later edited. Sub-calls run with NO trace step (so they don't clobber the
 * recipe's own step meta) but keep ownerId + agent context.
 */
async function dispatchRecipe(
  h: Extract<ToolHandler, { kind: 'recipe' }>,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  depth: number,
): Promise<ToolHandlerResult> {
  if (depth >= MAX_RECIPE_DEPTH) {
    return { ok: false, error: `recipe nesting too deep (max ${MAX_RECIPE_DEPTH})` };
  }
  const scope: RecipeScope = { input, steps: {} };
  // Steps run for the recipe's caller: they inherit its surface, so an
  // owner-only step is refused unless the recipe itself ran for the owner.
  const subCtx: ToolHandlerContext = {
    ownerId: ctx.ownerId,
    agent: ctx.agent,
    ...(ctx.surface ? { surface: ctx.surface } : {}),
  };
  // The recipe's caller calls each step too (A5 step 3a; undefined for an
  // entry that names none yet: its steps run as it ran).
  const trace: { tool: string; ms: number }[] = [];
  // Provenance: once ANY step pulls third-party content (an http tool, or a
  // web builtin like web_search — which the safety envelope permits), the
  // whole recipe's output is tainted — templating can thread that content
  // into later steps and the final output, so the taint can't be scoped
  // to one step.
  let untrusted = false;

  for (let i = 0; i < h.steps.length; i++) {
    const step = h.steps[i]!;
    const row = await resolveTool(ctx.ownerId, step.tool);
    const verdict = classifyRecipeStepTool({
      slug: step.tool,
      exists: !!row,
      kind: row?.handler.kind,
      requiresConfirm: row?.requiresConfirm,
    });
    if (verdict !== 'ok' || !row) {
      return { ok: false, error: `recipe step ${i}: ${recipeVerdictReason(step.tool, verdict)}` };
    }

    let stepInput: Record<string, unknown>;
    try {
      const resolved = resolveTemplateValue(step.input ?? {}, scope);
      stepInput = (
        resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? resolved : {}
      ) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        error: `recipe step ${i} ('${step.tool}'): ${errorMessage(err)}`,
      };
    }

    const t0 = performance.now();
    const res = await dispatchTool(row, stepInput, { ...subCtx, caller: ctx.caller }, depth + 1);
    trace.push({ tool: step.tool, ms: Math.round(performance.now() - t0) });
    if (!res.ok) {
      return { ok: false, error: `recipe step ${i} ('${step.tool}') failed: ${res.error}` };
    }
    if (res.untrusted || UNTRUSTED_CONTENT_TOOL_SLUGS.has(step.tool)) untrusted = true;
    scope.steps[String(i)] = res.output;
    if (step.as) scope.steps[step.as] = res.output;
  }

  const output =
    h.output !== undefined
      ? resolveTemplateValue(h.output, scope)
      : scope.steps[String(h.steps.length - 1)];
  ctx.step?.setMeta({ recipe_steps: trace, step_count: h.steps.length });
  return { ok: true, output, ...(untrusted ? { untrusted: true } : {}) };
}

const SHELL_TIMEOUT_MS = 30_000;
const SHELL_OUTPUT_CAP = 10 * 1024;

/**
 * Run a shell command template. Placeholders `${input.<field>}` are
 * substituted with shell-escaped values from the input. The command
 * runs via /bin/sh -c with a hard timeout + output cap. stdout +
 * stderr + exit code come back as JSON for the model.
 *
 * NOT a sandbox. The operator owns the cmd template; the model only
 * supplies args. Don't register shell tools you wouldn't paste into
 * your own terminal.
 */
async function dispatchShell(
  h: Extract<ToolHandler, { kind: 'shell' }>,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolHandlerResult> {
  const { exec } = await import('node:child_process');
  const cmd = renderShellCommand(h.cmd, input);
  ctx.step?.setMeta({ cmd });
  return new Promise((resolve) => {
    exec(
      cmd,
      {
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: SHELL_OUTPUT_CAP,
        shell: '/bin/sh',
        // Same scrub as run_terminal: stdout goes back to the model, so the
        // child must never see MANTLE_MASTER_KEY & co (see sanitized-env.ts).
        env: sanitizedEnv(),
      },
      (err, stdout, stderr) => {
        const out = String(stdout).slice(0, SHELL_OUTPUT_CAP);
        const errOut = String(stderr).slice(0, SHELL_OUTPUT_CAP);
        if (err) {
          const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          resolve({
            ok: false,
            error: `shell exited with ${exitCode ?? 'error'}: ${err.message}\nstderr:\n${errOut}`,
          });
          return;
        }
        resolve({ ok: true, output: { stdout: out, stderr: errOut, exitCode: 0 } });
      },
    );
  });
}

/** Shell-escape a single value via single-quote wrapping. Internal
 *  single quotes become `'\''`. Non-string values are JSON-stringified. */
function shellEscape(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else s = JSON.stringify(v);
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Substitute `${input.<key>}` in the template with shell-escaped values. */
function renderShellCommand(template: string, input: Record<string, unknown>): string {
  return template.replace(/\$\{input\.([a-zA-Z0-9_]+)\}/g, (_, key: string) =>
    shellEscape(input[key]),
  );
}

/** Decrypt every `{{secret:service/label}}` ref the handler's templates
 *  mention. Missing vault entries fail the call up-front with a clear
 *  message instead of sending a request with a literal ref in it. */
async function resolveHandlerSecrets(
  ownerId: string,
  h: Extract<ToolHandler, { kind: 'http' }>,
): Promise<{ secrets: Map<string, string> } | { error: string }> {
  const secrets = new Map<string, string>();
  for (const ref of collectSecretRefs(h)) {
    // The `mcp-` service namespace holds connector-sealed OAuth state (live
    // bearer tokens, registration secrets). Never resolvable from a template.
    if (isMcpManagedSecretService(ref.service)) {
      return {
        error: `secret '${refKey(ref)}' is connector-managed OAuth state (the 'mcp-' service namespace is reserved) — it cannot be referenced from tool templates; use a key the owner added under Settings → API keys`,
      };
    }
    const plaintext = await getApiKey(ownerId, ref.service, ref.label);
    if (plaintext === null) {
      return {
        error: `secret '${refKey(ref)}' not found in the API-key vault — add it under Settings → API keys (service '${ref.service}', label '${ref.label}')`,
      };
    }
    secrets.set(refKey(ref), plaintext);
  }
  return { secrets };
}

/** What a `{{oauth:<slug>}}` ref needs at send time: how to get (and, after
 *  a 401, replace) the token, and the only origin it may be sent to. */
type OauthBinding = {
  slug: string;
  origin: string;
  token: (staleToken?: string) => Promise<string>;
};

/** Load the group behind a `{{oauth:<slug>}}` ref and its vault credentials.
 *  Every failure is a teaching error; no token is fetched until all pass. */
async function resolveOauthBinding(
  ownerId: string,
  slug: string,
): Promise<OauthBinding | { error: string }> {
  // asSystem: like an MCP connector's binding, the group's auth config is
  // infrastructure; a client-level caller may not read the group row.
  const [group] = await asSystem(
    () =>
      db
        .select()
        .from(toolGroups)
        .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, slug)))
        .limit(1),
    'connector-binding',
  );
  const config = group?.integration?.oauth2;
  if (!group || !config) {
    return {
      error: `{{oauth:${slug}}} names no integration group with OAuth2 configured. Set oauth2 on group '${slug}' with tool_group_ensure`,
    };
  }
  if (!group.enabled) {
    return {
      error: `integration group '${slug}' is disabled. Ask the owner to enable it under Settings → Tool groups`,
    };
  }
  // The group's OAuth2 credentials go to its token URL and base URL only
  // while the login that paired them holds the keys area (W7 integration
  // fix 2): the same run-time check as an MCP connector's key.
  const pairRefused = await vaultPairRunRefusal(group.configuredBy, ownerId, true);
  if (pairRefused) return { error: pairRefused };
  let origin: string;
  try {
    origin = new URL(group.integration?.baseUrl ?? '').origin;
  } catch {
    return {
      error: `integration group '${slug}' has OAuth2 but no valid base_url. The token is only ever sent to the base_url's origin, so set base_url with tool_group_ensure`,
    };
  }
  const creds: string[] = [];
  for (const ref of [config.clientIdRef, config.clientSecretRef]) {
    const [service, label] = ref.split('/') as [string, string];
    if (isMcpManagedSecretService(service)) {
      return {
        error: `OAuth2 credential '${ref}' is in the reserved 'mcp-' vault namespace. Use a key the owner added under Settings → API keys`,
      };
    }
    const plaintext = await getApiKey(ownerId, service, label);
    if (plaintext === null) {
      return {
        error: `OAuth2 credential '${ref}' for group '${slug}' not found in the API-key vault. Add it under Settings → API keys (service '${service}', label '${label}')`,
      };
    }
    creds.push(plaintext);
  }
  const [clientId, clientSecret] = creds as [string, string];
  return {
    slug,
    origin,
    token: (staleToken) =>
      getClientCredentialsToken({
        ownerId,
        groupSlug: slug,
        config,
        clientId,
        clientSecret,
        ...(staleToken !== undefined ? { staleToken } : {}),
      }),
  };
}

async function dispatchHttp(
  h: Extract<ToolHandler, { kind: 'http' }>,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  tool?: { createdBy?: string | null },
): Promise<ToolHandlerResult> {
  // A tool another Admin login wrote resolves its vault refs only while
  // that login holds the keys area (W7a fix round 3, secret-ref-gate.ts).
  const makerRefused = await secretRefsRunRefusal(tool, h, ctx.ownerId);
  if (makerRefused) return { ok: false, error: makerRefused };
  const resolved = await resolveHandlerSecrets(ctx.ownerId, h);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const { secrets } = resolved;
  const scrub = (s: string) => scrubSecrets(s, secrets);

  const oauthSlugs = collectOauthRefs(h);
  if (oauthSlugs.length > 1) {
    return {
      ok: false,
      error: `a tool may reference one OAuth2 group, not ${oauthSlugs.length} (${oauthSlugs.join(', ')}). Author one tool per group`,
    };
  }
  let oauth: OauthBinding | null = null;
  if (oauthSlugs.length === 1) {
    const binding = await resolveOauthBinding(ctx.ownerId, oauthSlugs[0]!);
    if ('error' in binding) return { ok: false, error: binding.error };
    oauth = binding;
  }

  try {
    // Inside the try: buildHttpRequest can throw (e.g. encodeURIComponent on a
    // lone surrogate in model input) and must surface as a scrubbed error, not
    // an unhandled rejection out of the dispatcher.
    const send = async (): Promise<{ res: Response; url: string; method: string }> => {
      const req = buildHttpRequest(h, input, secrets);
      // The token goes to the group's own API and nowhere else: a template or
      // a model-filled {param} that points the request at another origin is
      // refused before anything is sent.
      if (oauth && new URL(req.url).origin !== oauth.origin) {
        throw new Error(
          `refused: this request goes to ${new URL(req.url).origin}, but the OAuth2 token of group '${oauth.slug}' is only sent to its base_url origin ${oauth.origin}`,
        );
      }
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: AbortSignal.timeout(h.timeoutMs ?? HTTP_TIMEOUT_MS_DEFAULT),
      };
      if (req.body !== null) init.body = req.body;
      const res = await safeFetch(req.url, init, [...secrets.values()]);
      return { res, url: req.url, method: req.method };
    };

    let token: string | undefined;
    if (oauth) {
      token = await oauth.token();
      secrets.set(oauthKey(oauth.slug), token);
    }
    let { res, url, method } = await send();
    if (oauth && token !== undefined && res.status === 401) {
      // The token may have been revoked or expired early: replace it once and
      // retry once. The dead token stays in the map so it is still scrubbed.
      await res.body?.cancel().catch(() => {});
      secrets.set(`${oauthKey(oauth.slug)}#stale`, token);
      secrets.set(oauthKey(oauth.slug), await oauth.token(token));
      ({ res, url, method } = await send());
    }
    const text = await res.text();
    ctx.step?.setMeta({
      url: scrub(url),
      method,
      status: res.status,
      length: text.length,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: scrub(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`),
      };
    }
    // Scrub the raw text BEFORE parsing so any secret an upstream reflects
    // back (echo endpoints, debug payloads, mirrored auth headers) is replaced
    // in the parsed object too — the plaintext must never reach the model.
    const scrubbed = scrub(text);
    let parsed: unknown = scrubbed;
    try {
      parsed = JSON.parse(scrubbed);
    } catch {
      /* keep raw text */
    }
    // Every http result is third-party authored — flag it so the tool-loop
    // fences it as data before the model reads it.
    return { ok: true, output: parsed, untrusted: true };
  } catch (err) {
    const msg = errorMessage(err);
    return { ok: false, error: scrub(msg) };
  }
}
registerToolDispatcher(dispatchTool);
