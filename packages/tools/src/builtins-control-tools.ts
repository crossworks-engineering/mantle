/**
 * Builtins: the Control Center's admin channel (docs/control-center.md,
 * "The admin channel"), the same act as POST /api/fleet/tool. On a Control
 * Center only, registered with the other control_* tools
 * (builtins-control.ts CONTROL_TOOLS). Admin only (the settings area); in no
 * shipped agent's grant. They queue calls on the CC's own rows and wait for
 * the answers: the control service alone signs and sends them, and each box
 * runs a call only within its own scope (MANTLE_CONTROL_CENTER_SCOPE).
 */
import { seal } from '@mantle/crypto';
import { askControlTools, type ControlToolAsk } from '@mantle/db/control-center';
import { isUuid } from '@mantle/std';
import { by, onCc } from './builtins-control';
import { CS } from './client-sourced-rule';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

const sealed = (plain: string, aad: string) => seal(plain, aad).ciphertext.toString('base64');

const ids = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v.filter((x): x is string => isUuid(x)).map((x) => x.toLowerCase())
    : undefined;

async function asked(ask: ControlToolAsk, who: string): Promise<ToolHandlerResult> {
  const r = await askControlTools(ask, who, sealed);
  return r.ok ? { ok: true, output: r.value } : { ok: false, error: r.error };
}

export const control_tool_list: BuiltinToolDef = {
  slug: 'control_tool_list',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    matrix: { none: "names no item: a call row on the Control Center's box list" },
    clientSourced: CS.always('it asks a box for the tools it lets the Control Center run'),
  },
  name: 'List the tools a fleet box allows',
  description:
    "The tools one linked box lets this Control Center run, with their input schemas, and the box's scope (`admin`: settings and management; `full`: every tool; `null`: the box allows none). Waits for the box; when it is slow, `pending` holds the call id: ask again with `control_tool_call` and `callIds`. Run one with `control_tool_call`.",
  inputSchema: {
    type: 'object',
    properties: {
      boxId: { type: 'string', description: 'A box id from control_box_list.' },
    },
    required: ['boxId'],
  },
  handler: (input, ctx) =>
    onCc('control_tool_list', async () => {
      if (!isUuid(input.boxId)) {
        return { ok: false, error: 'boxId must be a box id: find it with control_box_list.' };
      }
      return asked({ boxIds: [String(input.boxId).toLowerCase()], list: true }, by(ctx));
    }),
};

export const control_tool_call: BuiltinToolDef = {
  slug: 'control_tool_call',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    matrix: { none: "names no item: a call row on the Control Center's box list" },
    clientSourced: CS.always('it runs a tool on every box it names'),
  },
  redactInputFields: ['args'],
  name: 'Run a tool on fleet boxes',
  description:
    "Run one of a box's own tools on each box `boxIds` names, as that box's Control Center admin; each box runs only what its scope allows (see `control_tool_list`). **Not undone and not retried**: a write is done once per box. Answers each box's result (`ok`, `output`, or a `reason`: `scope`, `tool`, `refused` with the tool's `error`, `replay`, or a call code such as `unreachable`, not confirmed). A slow box's call id stays in `pending`: pass it back as `callIds` (with no other field) for its answer.",
  inputSchema: {
    type: 'object',
    properties: {
      boxIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 50,
        description: 'Box ids from control_box_list.',
      },
      name: { type: 'string', description: 'The tool, from control_tool_list, e.g. agent_list.' },
      args: {
        type: 'object',
        additionalProperties: true,
        description: "The tool's own arguments, as its input schema in control_tool_list says.",
      },
      callIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 100,
        description: 'Instead of a call: the pending ids of an earlier answer.',
      },
    },
  },
  handler: (input, ctx) =>
    onCc('control_tool_call', async () => {
      if (input.callIds !== undefined) {
        const callIds = ids(input.callIds);
        if (!callIds || callIds.length === 0) {
          return { ok: false, error: 'callIds must be the pending ids of an earlier answer.' };
        }
        return asked({ callIds }, by(ctx));
      }
      const boxIds = ids(input.boxIds);
      if (!boxIds || boxIds.length === 0) {
        return { ok: false, error: 'boxIds must be a list of box ids from control_box_list.' };
      }
      const args = input.args ?? {};
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return { ok: false, error: "args must be an object of the tool's own arguments." };
      }
      return asked(
        {
          boxIds,
          name: typeof input.name === 'string' ? input.name : '',
          args: args as Record<string, unknown>,
        },
        by(ctx),
      );
    }),
};
