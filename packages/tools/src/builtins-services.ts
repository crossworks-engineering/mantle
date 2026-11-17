/**
 * Settings > Services over MCP (docs/services.md): list the box's optional
 * services and switch one on or off. The same view and the same switch
 * request as GET /api/services and POST /api/services/:name, through the
 * services bridge (services-bridge.ts), so an admin's own agent runs a box
 * the way the screen does (admin settings are never screen-only).
 *
 * `mcpOnly`: an Admin user's own client; no in-brain agent is granted them.
 * The settings area, run whole (a switch is the box's, not a workspace's).
 */
import { OPTIONAL_SERVICES } from '@mantle/config';
import type { OptionalServiceName, ServicesView } from '@mantle/client-types';
import { getServicesProvider, SERVICES_UNAVAILABLE } from './services-bridge';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { CS } from './client-sourced-rule';

function viewOut(v: ServicesView) {
  return {
    services: v.services.map((s) => ({
      name: s.name,
      title: s.description.title,
      state: s.state,
      container: s.container,
      health: s.health,
      when_off: s.description.whenOff,
      memory: s.description.memory,
    })),
    switching: v.switching,
    run: v.run,
    box: v.box,
  };
}

export const service_list: BuiltinToolDef = {
  slug: 'service_list',
  mcpOnly: true,
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'settings', systemWhole: true },
    recipe: { step: 'forbidden' },
  },
  name: 'List box services',
  description:
    "List this box's optional services (Settings > Services): each one's state (`off`, `up` or `down`), its container and health, what stops while it is off and its memory; whether this box can switch them now, and the latest switch run with its outcome. Read-only. To switch one use `service_set`.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    const p = getServicesProvider();
    if (!p) return { ok: false, error: SERVICES_UNAVAILABLE };
    return { ok: true, output: viewOut(await p.view(ctx.ownerId)) };
  },
};

export const service_set: BuiltinToolDef = {
  slug: 'service_set',
  mcpOnly: true,
  policy: {
    matrix: { none: 'a box service is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings', systemWhole: true },
    peerRisky: true,
    idempotent: true, // a switch to a state
    recipe: { step: 'forbidden' },
    clientSourced: CS.always('switches a service of the box on or off'),
  },
  name: 'Switch a box service',
  description:
    "Ask the updater to switch one optional service on or off (Settings > Services). It returns at once: the updater pulls and starts the service, or stops it, within a few minutes; follow it in `service_list`'s `run`. Off never deletes anything: data, tokens and images stay. Turning `sync` off hides Email, Contacts and the account screens and their tools, and pauses their sync. Refused while an update or another switch runs, or when this box cannot switch services.",
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        enum: [...OPTIONAL_SERVICES],
        description: "The service, e.g. 'sync'.",
      },
      enable: { type: 'boolean', description: 'true switches it on, false off.' },
    },
    required: ['name', 'enable'],
  },
  handler: async (input): Promise<ToolHandlerResult> => {
    const p = getServicesProvider();
    if (!p) return { ok: false, error: SERVICES_UNAVAILABLE };
    const name = String(input.name ?? '');
    if (!(OPTIONAL_SERVICES as readonly string[]).includes(name)) {
      return {
        ok: false,
        error: `unknown service '${name}': use one of ${OPTIONAL_SERVICES.join(', ')} (service_list shows them)`,
      };
    }
    if (typeof input.enable !== 'boolean') {
      return { ok: false, error: '`enable` must be true (on) or false (off)' };
    }
    const res = await p.set(name as OptionalServiceName, input.enable);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      output: {
        requested: { name, enable: input.enable },
        next: 'The updater runs the switch now; call service_list to follow `run`.',
      },
    };
  },
};

/** Registered on the MCP surface (build-server.ts); no agent is granted
 *  them. */
export const SERVICE_TOOLS: readonly BuiltinToolDef[] = [service_list, service_set];
