/**
 * The one rule (owner, 2026-11-07): an agent may tighten a gate, never loosen
 * one.
 *
 * An agent is any MCP client (stdio, OAuth, API key, peer), an Admin's and the
 * anchor owner's too, and any in-brain turn. A person acts in the app, on a
 * Telegram card (an approved held call) or in the dev tool console.
 *
 * A gate is a check that makes a PERSON look at what an agent does: an
 * approval, a confirm flag, an attest, a publish or confirm step. It is not a
 * rights rule: the Write switch, item rights and public links are not gates
 * here, and whatever a person can do by right their agent can do too.
 *
 * Each row is one act. A row with no `param` is a whole tool that is on no agent
 * surface: no such builtin exists, and no authored tool may take its name. A
 * row with a `param` names the one value an agent may send: personOnlyRefusal,
 * the one check, which dispatchTool asks on every call of a builtin, refuses any
 * other value.
 *
 * An agent's call with such a value is refused when it reaches dispatch. An
 * in-brain turn's call that first waits in Pending (a confirm-gated tool, a turn
 * that read a client's text) reaches dispatch only when a person approves it:
 * that approval is the person's act. The confirm flag and the tool-grant parks
 * are something else: they hold in-brain agents only, and an MCP client acts at
 * once (owner, 2026-11-07).
 *
 * Not gates, by the owner's word: app_publish, page_commit, table_commit and
 * recall_map_delete's confirm follow the member's rights. A NEW item (made,
 * uploaded, copied or exported into a folder) asks no visibility confirm: it
 * takes its folder's sharing, for every caller (owner's word, 2026-11-12);
 * its tools keep the `confirm` param, ignored, for older callers. A move of
 * an existing item still asks. With
 * toolsmithRequireApproval off the owner trusts agents to make tools, so an
 * agent may delete a tool and make it again with no gate. In a group another
 * workspace holds, an in-brain agent's change to it waits (heldGroupDoor, which
 * asks isPersonCall and the MCP entry), and a tool made again joins a group only
 * through that door: its name left the list.
 *
 * person-only-acts.test.ts (packages/mcp-core) holds the list whole, over the
 * real SDK, and sweeps every tool for a param that looks like a gate.
 */
import type { ToolCaller } from './gate-callers';

export type PersonOnlyAct = Readonly<{
  /** The tool. */
  tool: string;
  /** The param that makes it a person's act. None: the whole tool. */
  param?: string;
  /** The one value of `param` an agent may send: the one that tightens. Any
   *  other value is a person's. */
  agentValue?: boolean;
  /** Why it is a person's. */
  why: string;
  /** Where a person does it, for the refusal. */
  where: string;
}>;

const SETTINGS_TOOLS = 'in Settings > Tools, on the tool';
const FLEET_SCREEN = "on the Control Center's Fleet screen";
const RECALL_EDITOR = 'in the Recall editor';

export const PERSON_ONLY_ACTS: readonly PersonOnlyAct[] = [
  {
    // On a Control Center only (the tool exists nowhere else).
    tool: 'control_ban',
    param: 'archive',
    agentValue: false,
    why: 'an archive is a permanent disable on every linked box: no lift undoes it, only a box Admin by hand',
    where: FLEET_SCREEN,
  },
  {
    // On a Control Center only: POST /api/fleet/invite, no tool.
    tool: 'control_user_invite',
    why: 'an invite is a way into a box: a person at the CC asks for it, with their own password',
    where: FLEET_SCREEN,
  },
  {
    tool: 'pending_approve',
    why: 'an agent would approve its own held call',
    where: 'on the Pending screen or the Telegram card',
  },
  {
    tool: 'api_tool_update',
    param: 'requires_confirm',
    agentValue: true,
    why: "it clears a tool's confirm gate",
    where: SETTINGS_TOOLS,
  },
  {
    tool: 'api_tool_update',
    param: 'enabled',
    agentValue: false,
    why: 'it turns back on a tool someone turned off',
    where: SETTINGS_TOOLS,
  },
  {
    tool: 'api_tool_update',
    param: 'external_access',
    agentValue: false,
    why: 'it opens the tool to shared apps on a read-only attest',
    where: SETTINGS_TOOLS,
  },
  {
    tool: 'recall_prompt_confirm',
    why: 'a confirmed prompt tells every agent what to do',
    where: RECALL_EDITOR,
  },
  {
    tool: 'recall_map_publish',
    why: "a new map's first appearance to every agent",
    where: RECALL_EDITOR,
  },
  {
    tool: 'recall_revision_restore',
    why: 'a person looks at the text a restore puts live, as at a published map or a confirmed prompt',
    where: RECALL_EDITOR,
  },
];

/** Whether `slug` is a whole tool on the list: a person's act, no tool's. */
export function isPersonOnlyTool(slug: string): boolean {
  return PERSON_ONLY_ACTS.some((a) => a.tool === slug && a.param === undefined);
}

/**
 * Whether a call is a person's, by its caller alone: the dev tool console, or a
 * held call a person approved on the Pending screen or a Telegram card. Every
 * other entry is an agent's or a process's.
 */
export function isPersonCall(ctx: { caller?: ToolCaller }) {
  return ctx.caller?.entry === 'owner-web' || ctx.caller?.entry === 'pending';
}

/**
 * The one check: the refusal of a param sent with any value but the one an agent
 * may send, or null. A param left out is no act.
 */
export function personOnlyRefusal(
  slug: string,
  input: Record<string, unknown>,
  ctx: { caller?: ToolCaller },
): string | null {
  const act = PERSON_ONLY_ACTS.find(
    (a) =>
      a.tool === slug &&
      a.param !== undefined &&
      input[a.param] !== undefined &&
      input[a.param] !== a.agentValue,
  );
  if (!act || isPersonCall(ctx)) return null;
  return `On ${slug} an agent may send ${act.param} only as ${String(act.agentValue)}. Any other value is a person's act, not an agent's: ${act.why}. An agent may tighten a gate, never loosen one. Leave ${act.param} out of this call and ask the user to do it ${act.where}.`;
}
