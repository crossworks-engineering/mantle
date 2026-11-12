/**
 * Builtins: the Control Center's tools (docs/control-center.md), the same
 * acts as the Fleet screen (server/web app/api/fleet). On a Control Center
 * only (MANTLE_IS_CONTROL_CENTER): the registry imports this module and
 * registers them on a CC alone (registry.ts), so elsewhere no control_*
 * tool exists and none of this is loaded. Admin only (the settings area);
 * the writes are peerRisky, so an API key must name them. In no shipped
 * agent's grant.
 *
 * They only write the CC's own rows. The calls to the boxes are made by the
 * control service alone, from these rows: no tool here signs anything.
 */
import { env, feature } from '@mantle/config';
import { seal } from '@mantle/crypto';
import {
  addControlBox,
  checkKeyInput,
  checkModelChanges,
  checkSettingChanges,
  controlKeyAad,
  queueControlKey,
  queueControlWrites,
  checkBan,
  checkBoxUrl,
  controlServiceState,
  liftControlBan,
  listControlBans,
  listControlBoxes,
  listControlMatrix,
  listControlResults,
  makeControlBan,
  previewControlBan,
  removeControlBox,
} from '@mantle/db/control-center';
import { isUuid, publicErrorText } from '@mantle/std';
import { areaSystem } from './admin-gate';
import { CS } from './client-sourced-rule';
import { actingLoginId } from './surface';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { control_tool_call, control_tool_list } from './builtins-control-tools';

const NOT_A_CC: ToolHandlerResult = {
  ok: false,
  error: 'This box is not a Control Center (MANTLE_IS_CONTROL_CENTER is not on).',
};

/** Runs `fn` on a CC, in the settings area, with its errors said plainly. */
export async function onCc(
  slug: string,
  fn: () => Promise<ToolHandlerResult>,
): Promise<ToolHandlerResult> {
  if (!feature('controlCenter')) return NOT_A_CC;
  try {
    return await areaSystem('settings', fn);
  } catch (err) {
    return { ok: false, error: publicErrorText(err, slug) };
  }
}

export const by = (ctx: ToolHandlerContext) => `mcp:${actingLoginId(ctx.surface) ?? ctx.ownerId}`;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const control_public_key: BuiltinToolDef = {
  slug: 'control_public_key',
  policy: { effect: 'read', spends: 'none', scope: { area: 'settings' } },
  name: 'Control Center key',
  description:
    "The Control Center's public key, its fingerprint, and the two .env lines each subject box sets (MANTLE_CONTROL_CENTER and MANTLE_CONTROL_CENTER_KEY). The public key is safe to show. `key: null` until the control service has started once.",
  inputSchema: { type: 'object', properties: {} },
  handler: () =>
    onCc('control_public_key', async () => {
      const s = await controlServiceState();
      const url = (env('MANTLE_PUBLIC_URL') ?? '').trim().replace(/\/+$/, '');
      return {
        ok: true,
        output: s
          ? {
              key: s.publicKey,
              fingerprint: s.fingerprint,
              lastTickAt: s.lastTickAt,
              envLines: [
                `MANTLE_CONTROL_CENTER=${url}`,
                `MANTLE_CONTROL_CENTER_KEY=${s.publicKey}`,
              ],
            }
          : { key: null },
      };
    }),
};

const control_box_list: BuiltinToolDef = {
  slug: 'control_box_list',
  policy: { effect: 'read', spends: 'none', scope: { area: 'settings' } },
  name: 'List fleet boxes',
  description:
    'The boxes linked to this Control Center: URL, label, last run, last good run, and `lastReason` when the last run failed (off: the box has no control lines in its .env; time: clock skew; sig: the box holds another key; unreachable; http-NNN). `lastResult` holds what the last run did there, with `owner`: box owners a ban matched, which stay live.',
  inputSchema: { type: 'object', properties: {} },
  handler: () =>
    onCc('control_box_list', async () => ({
      ok: true,
      output: { boxes: await listControlBoxes() },
    })),
};

const control_box_add: BuiltinToolDef = {
  slug: 'control_box_add',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    matrix: { none: "names no item: a row of the Control Center's box list" },
    clientSourced: CS.always('it points the fleet ban at another box'),
  },
  name: 'Link a fleet box',
  description:
    'Link a subject box by its https origin (no path). The box must also carry the two .env lines from `control_public_key`; until then its runs fail with `off`. Its first run starts at once.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The box origin, e.g. https://box.example.com' },
      label: { type: 'string', description: 'A short name for the box (optional).' },
    },
    required: ['url'],
  },
  handler: (input, ctx) =>
    onCc('control_box_add', async () => {
      const url = checkBoxUrl(str(input.url) ?? '');
      if (!url.ok) return { ok: false, error: url.error };
      const box = await addControlBox(url.value, str(input.label) ?? null, by(ctx));
      return box
        ? { ok: true, output: { box } }
        : { ok: false, error: 'That box is already linked.' };
    }),
};

const control_box_remove: BuiltinToolDef = {
  slug: 'control_box_remove',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    destructive: true,
    // A remove is a delete (risk-class-snapshot.test.ts), though a box row
    // is no item: control_box_add links it again.
    riskClass: 'delete',
    idempotent: true,
    matrix: { none: "names no item: a row of the Control Center's box list" },
    clientSourced: CS.always('it stops the fleet ban reaching a box'),
  },
  name: 'Unlink a fleet box',
  description:
    'Stop every call from this Control Center to a box. What was done on the box stays as it is.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The box id from control_box_list.' } },
    required: ['id'],
  },
  handler: (input) =>
    onCc('control_box_remove', async () => {
      const id = str(input.id);
      if (!id || !isUuid(id)) return { ok: false, error: 'Give the box id from control_box_list.' };
      return (await removeControlBox(id.toLowerCase()))
        ? { ok: true, output: { removed: true } }
        : { ok: false, error: 'Box not found.' };
    }),
};

const control_ban: BuiltinToolDef = {
  slug: 'control_ban',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    matrix: { none: "names no item: a row of the Control Center's bans" },
    clientSourced: CS.always('it disables people on every linked box'),
  },
  name: 'Ban a person on the fleet',
  description:
    "Disable a person's logins on every linked box. Matched by email (lowercase, exact) and, when given, by a company sign-in issuer plus object id. control_ban_lift undoes it. `archive: true` makes it a permanent disable instead (the login never signs in again, nothing is deleted, only a box Admin restores it by hand): a person's act, so an agent may send only `archive: false`; ask the user to archive on the Fleet screen. A box owner is never disabled; it is reported. Call with `preview: true` first to see what the ban matches on each box, then again without it to make the ban; it runs at once.",
  inputSchema: {
    type: 'object',
    properties: {
      emails: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 50,
        description: "The person's email addresses, e.g. ['ann@example.com'].",
      },
      issuer: { type: 'string', description: 'Company sign-in issuer URL (optional, with oid).' },
      oid: { type: 'string', description: 'Company sign-in object id (optional, with issuer).' },
      archive: {
        type: 'boolean',
        description:
          "true: a permanent disable (a person's act). Left out or false: a disable the CC can lift.",
      },
      reason: { type: 'string', description: 'Why, for the record (optional).' },
      preview: { type: 'boolean', description: 'true: make nothing, show the matches.' },
    },
  },
  handler: (input, ctx) =>
    onCc('control_ban', async () => {
      const ban = checkBan({
        emails: Array.isArray(input.emails)
          ? input.emails.filter((e): e is string => typeof e === 'string')
          : [],
        issuer: str(input.issuer) ?? null,
        oid: str(input.oid) ?? null,
        kind: input.archive === true ? 'archive' : 'disable',
        reason: str(input.reason) ?? null,
      });
      if (!ban.ok) return { ok: false, error: ban.error };
      if (input.preview === true) {
        return { ok: true, output: { preview: await previewControlBan(ban.value) } };
      }
      return { ok: true, output: { ban: await makeControlBan(ban.value, by(ctx)) } };
    }),
};

const control_ban_list: BuiltinToolDef = {
  slug: 'control_ban_list',
  policy: { effect: 'read', spends: 'none', scope: { area: 'settings' } },
  name: 'List fleet bans',
  description:
    'The fleet bans: keys, kind, who made and lifted each, how many boxes and logins the last runs matched, and `ownerIds` (box owners a ban matched, never disabled). `lifted: true` lists lifted bans too. `results` gives the same per box.',
  inputSchema: {
    type: 'object',
    properties: { lifted: { type: 'boolean', description: 'true: lifted bans too.' } },
  },
  handler: (input) =>
    onCc('control_ban_list', async () => ({
      ok: true,
      output: {
        bans: await listControlBans({ lifted: input.lifted === true }),
        results: await listControlResults(),
      },
    })),
};

const control_ban_lift: BuiltinToolDef = {
  slug: 'control_ban_lift',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    matrix: { none: "names no item: a row of the Control Center's bans" },
    clientSourced: CS.always('it lets banned people back in on every box'),
  },
  name: 'Lift a fleet ban',
  description:
    'Lift a fleet ban. A disable ban: the next run re-enables the logins it disabled that no other active ban matches, and never a login a box Admin disabled by hand. An archive ban is retired: its runs stop, and its logins stay archived until a box Admin restores them by hand.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The ban id from control_ban_list.' } },
    required: ['id'],
  },
  handler: (input, ctx) =>
    onCc('control_ban_lift', async () => {
      const id = str(input.id);
      if (!id || !isUuid(id)) return { ok: false, error: 'Give the ban id from control_ban_list.' };
      const ban = await liftControlBan(id.toLowerCase(), by(ctx));
      return ban
        ? { ok: true, output: { ban } }
        : { ok: false, error: 'No active ban with that id.' };
    }),
};

const control_key_set: BuiltinToolDef = {
  slug: 'control_key_set',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    matrix: { none: "names no item: a key job on the Control Center's box rows" },
    clientSourced: CS.always('it sets a provider key on every box it names'),
  },
  redactInputFields: ['value'],
  name: 'Set a provider key on the fleet',
  description:
    "Set or replace one provider key (e.g. `openrouter`) on every linked box, or on the boxes `boxIds` names. Each box sets it as its Keys screen does, tests it, and answers ok or a reason (`service`: not on that box's list; `refused`: the name holds a password or the vault said no; `untested`: set, no test; `failed`: the provider refused it, and the box is put back as it was). The CC holds the key sealed until it is sent (seconds), an hour at most. See each box's `keyResult` in `control_box_list`.",
  inputSchema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description: "The provider's name on the boxes, e.g. openrouter.",
      },
      value: { type: 'string', description: 'The key itself.' },
      boxIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 500,
        description: 'Box ids from control_box_list (optional: every linked box).',
      },
    },
    required: ['service', 'value'],
  },
  handler: (input, ctx) =>
    onCc('control_key_set', async () => {
      const k = checkKeyInput({ service: str(input.service), value: str(input.value) });
      if (!k.ok) return { ok: false, error: k.error };
      // boxIds left out: every box. Present, it must be a list (fails closed).
      if (input.boxIds !== undefined && !Array.isArray(input.boxIds)) {
        return { ok: false, error: 'boxIds must be a list of box ids from control_box_list.' };
      }
      const ids = Array.isArray(input.boxIds)
        ? input.boxIds.filter((v): v is string => isUuid(v)).map((v) => v.toLowerCase())
        : undefined;
      const queued: string[] = await queueControlKey(
        k.value.service,
        (boxId) => seal(k.value.value, controlKeyAad(boxId)).ciphertext.toString('base64'),
        by(ctx),
        ids,
      );
      if (ids !== undefined && queued.length === 0) {
        return {
          ok: false,
          error: 'No linked box has those ids: find them with control_box_list.',
        };
      }
      return {
        ok: true,
        output: { service: k.value.service, queued: queued.length, boxIds: queued },
      };
    }),
};

const control_agent_model_set: BuiltinToolDef = {
  slug: 'control_agent_model_set',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    matrix: { none: "names no item: a model job on the Control Center's box rows" },
    clientSourced: CS.always('it changes the model of agents on every box it names'),
  },
  name: 'Set agent models on the fleet',
  description:
    "Set the model of agents the system ships (e.g. `coder`) on every linked box, or on the boxes `boxIds` names. The model field only: each box keeps the agent's provider and key, checks its own model policy, and answers ok with the model it had (`was`) or a reason (`agent`: no shipped agent with that slug; `policy`: the box's policy blocks it; or a call code such as `unreachable`, not confirmed). Sent at once; changes join what waits for a box. Read the current models first with `control_fleet_matrix`; see each box's `writeResult` in `control_box_list`.",
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'A shipped agent, e.g. coder.' },
            model: { type: 'string', description: 'The model id, e.g. vendor/model-name.' },
          },
          required: ['slug', 'model'],
        },
        description: 'Each agent and its new model.',
      },
      boxIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 500,
        description: 'Box ids from control_box_list (optional: every linked box).',
      },
    },
    required: ['changes'],
  },
  handler: (input, ctx) =>
    onCc('control_agent_model_set', async () => {
      if (!Array.isArray(input.changes)) {
        return { ok: false, error: 'changes must be a list of { slug, model }.' };
      }
      const c = checkModelChanges(input.changes);
      if (!c.ok) return { ok: false, error: c.error };
      // boxIds left out: every box. Present, it must be a list (fails closed).
      if (input.boxIds !== undefined && !Array.isArray(input.boxIds)) {
        return { ok: false, error: 'boxIds must be a list of box ids from control_box_list.' };
      }
      const ids = Array.isArray(input.boxIds)
        ? input.boxIds.filter((v): v is string => isUuid(v)).map((v) => v.toLowerCase())
        : undefined;
      const queued = await queueControlWrites(c.value, by(ctx), ids);
      if (ids !== undefined && queued.length === 0) {
        return {
          ok: false,
          error: 'No linked box has those ids: find them with control_box_list.',
        };
      }
      return { ok: true, output: { changes: c.value, queued: queued.length, boxIds: queued } };
    }),
};

const control_fleet_settings_set: BuiltinToolDef = {
  slug: 'control_fleet_settings_set',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    matrix: { none: "names no item: a write job on the Control Center's box rows" },
    clientSourced: CS.always(
      'it changes pools, the update notice or worker groups on every box it names',
    ),
  },
  name: 'Set pool entries, the update notice or worker groups on the fleet',
  description:
    "Queue changes for every linked box, or the boxes `boxIds` names: a model pool entry (`poolEntry`, added or its routes updated by pool and name), the update notice (`updateNotice`, on blocks every login on the box for up to an hour), or a worker group (`workerGroup`, made or updated by slug). Each box runs its own check and answers ok with `was` (added, updated, on, off) or a reason (`pool`, `fit`, `members`, or a call code such as `unreachable`, not confirmed). Sent at once. For agent models use `control_agent_model_set`; see each box's `writeResult` in `control_box_list`.",
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['poolEntry', 'updateNotice', 'workerGroup'] },
            pool: { type: 'string', description: 'poolEntry: the pool id, e.g. agents.' },
            name: {
              type: 'string',
              description:
                'poolEntry: the model name, e.g. Claude Sonnet 5. workerGroup: its display name.',
            },
            vendor: { type: 'string', description: 'poolEntry: the maker, e.g. Anthropic.' },
            routes: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  provider: { type: 'string', description: 'e.g. openrouter' },
                  model: {
                    type: 'string',
                    description: "That provider's id, e.g. vendor/model-name.",
                  },
                },
                required: ['provider', 'model'],
              },
              description: 'poolEntry: one row per provider route.',
            },
            on: { type: 'boolean', description: 'updateNotice: show (true) or hide (false).' },
            slug: {
              type: 'string',
              description: 'workerGroup: the group slug, e.g. review-panel.',
            },
            members: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: { type: 'string' },
              description: 'workerGroup: enabled worker slugs on each box.',
            },
            enabled: { type: 'boolean', description: 'workerGroup: whether the panel is live.' },
          },
          required: ['kind'],
        },
        description: 'Each change, by kind.',
      },
      boxIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 500,
        description: 'Box ids from control_box_list (optional: every linked box).',
      },
    },
    required: ['changes'],
  },
  handler: (input, ctx) =>
    onCc('control_fleet_settings_set', async () => {
      if (!Array.isArray(input.changes)) {
        return { ok: false, error: 'changes must be a list of { kind, ... }.' };
      }
      const c = checkSettingChanges(input.changes);
      if (!c.ok) return { ok: false, error: c.error };
      if (input.boxIds !== undefined && !Array.isArray(input.boxIds)) {
        return { ok: false, error: 'boxIds must be a list of box ids from control_box_list.' };
      }
      const ids = Array.isArray(input.boxIds)
        ? input.boxIds.filter((v): v is string => isUuid(v)).map((v) => v.toLowerCase())
        : undefined;
      const queued = await queueControlWrites(c.value, by(ctx), ids);
      if (ids !== undefined && queued.length === 0) {
        return {
          ok: false,
          error:
            'No box was queued: no linked box has those ids (control_box_list), or 40 changes already wait for it.',
        };
      }
      return { ok: true, output: { changes: c.value, queued: queued.length, boxIds: queued } };
    }),
};

const control_fleet_matrix: BuiltinToolDef = {
  slug: 'control_fleet_matrix',
  policy: { effect: 'read', spends: 'none', scope: { area: 'settings' } },
  name: 'Read the fleet matrix',
  description:
    "Per linked box, its last good facts: box status numbers (version, health, CPU, memory, disk, services, spend, queues, logins by role), the company sign-in mode, each agent's role, provider, model and on or off (its slug only when the system ships it, e.g. `coder`, else null; `assigned`: a person's own assistant), each AI worker's kind, provider and model, workspace and app counts, and the last backup. `facts.at` is the box's time of the read; `factsReason` says why the last read failed (the old facts stay). Read every 5 minutes. Never a prompt, a key or user data. For one box pass `boxId`; for links, bans and key results use `control_box_list`.",
  inputSchema: {
    type: 'object',
    properties: {
      boxId: { type: 'string', description: 'One box id from control_box_list (optional).' },
    },
  },
  handler: (input) =>
    onCc('control_fleet_matrix', async () => {
      const id = str(input.boxId);
      if (id !== undefined && !isUuid(id)) {
        return { ok: false, error: 'boxId must be a box id from control_box_list.' };
      }
      return { ok: true, output: { boxes: await listControlMatrix(id?.toLowerCase()) } };
    }),
};

export const CONTROL_TOOLS: readonly BuiltinToolDef[] = [
  control_public_key,
  control_box_list,
  control_fleet_matrix,
  control_box_add,
  control_box_remove,
  control_ban,
  control_ban_list,
  control_ban_lift,
  control_key_set,
  control_agent_model_set,
  control_fleet_settings_set,
  control_tool_list,
  control_tool_call,
];
