/**
 * Builtins: update_notice_on and update_notice_off, the "Update In Progress"
 * screen every signed-in login on this box sees while it is on
 * (@mantle/client-types dto/update-notice.ts). Admin only (the settings
 * area), on MCP too, so an operator's agent switches it around work on a box.
 *
 * Nothing has to switch it off for a box to come back: an "on" counts only
 * while the box runs the version it was set on, and for an hour at most
 * (updateNoticeOn). The box's own updater shows the notice while it pulls or
 * rolls a release, with no call at all.
 */
import { setUpdateNotice } from '@mantle/content';
import { manualNoticeUntil } from '@mantle/client-types/update-notice';
import { APP_VERSION } from '@mantle/client-types/version';
import { publicErrorText } from '@mantle/std';
import { CS } from './client-sourced-rule';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

async function switchNotice(ownerId: string, on: boolean): Promise<ToolHandlerResult> {
  try {
    const stored = await setUpdateNotice(ownerId, on);
    const until = manualNoticeUntil(stored, APP_VERSION, Date.now());
    return {
      ok: true,
      output: {
        on: until !== null,
        version: APP_VERSION,
        until: until === null ? null : new Date(until).toISOString(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: publicErrorText(err, on ? 'update_notice_on' : 'update_notice_off'),
    };
  }
}

const update_notice_on: BuiltinToolDef = {
  slug: 'update_notice_on',
  policy: {
    idempotent: true, // sets the one value (a second call restarts its hour)
    matrix: { none: 'names no item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    clientSourced: CS.always('it blocks every login on the box for up to an hour'),
  },
  name: 'Show the update notice',
  description:
    'Show every signed-in login on this box a full-screen "Update In Progress" notice they cannot close, until `update_notice_off`. Use right before work that restarts the box. It clears by itself when the box runs a new version, or an hour after this call. A release rolled by the box\'s own updater shows it with no call. Returns `until`, when it clears by itself.',
  inputSchema: { type: 'object', properties: {} },
  handler: (_input, ctx) => switchNotice(ctx.ownerId, true),
};

const update_notice_off: BuiltinToolDef = {
  slug: 'update_notice_off',
  policy: {
    idempotent: true, // clears the one value
    matrix: { none: 'names no item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    clientSourced: CS.free('it only lifts the box-wide update notice'),
  },
  name: 'Hide the update notice',
  description:
    'Hide the "Update In Progress" notice `update_notice_on` showed: every login\'s screen comes back within seconds. While the box\'s own updater is still pulling or rolling a release the notice stays until that run ends.',
  inputSchema: { type: 'object', properties: {} },
  handler: (_input, ctx) => switchNotice(ctx.ownerId, false),
};

export const UPDATE_NOTICE_TOOLS: readonly BuiltinToolDef[] = [update_notice_on, update_notice_off];
