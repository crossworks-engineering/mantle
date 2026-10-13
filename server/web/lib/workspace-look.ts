/**
 * A workspace's look (task 5edc9149, migration 0285): its colour, its icon
 * and its kind, on every workspace the brain lists: the workspace list and
 * screen (lib/workspaces.ts), the switcher's list (/api/shell, the same
 * module) and the workspace chips of the lists and the tree
 * (lib/list-workspaces.ts). One place says how it is read, so every list
 * says the same.
 *
 * The kind comes from mantle_ws_kind (0285), which answers only for a
 * workspace the scope may name. The colour and icon are checked on the way
 * in with the folder's own validators (lib/look-body.ts) and again on the
 * way out: a value no client can draw goes out as null (the default).
 */
import { sql } from '@mantle/db';
import { isAppTint } from '@mantle/client-types/app-nav';
import { projectAppIcon } from '@mantle/content-core/app-nav';
import type { WorkspaceKind, WorkspaceLook } from '@mantle/client-types';

const KINDS: readonly WorkspaceKind[] = ['admin', 'team', 'private', 'other'];

/** The look of the workspace row aliased `w`, as select columns. */
export const WS_LOOK_COLUMNS = sql`w.color as look_color, w.icon as look_icon,
  "public"."mantle_ws_kind"(w.id) as look_kind`;

/** The same, as jsonb_build_object pairs (a chip built in SQL). */
export const WS_LOOK_PAIRS = sql`'color', w.color, 'icon', w.icon,
  'kind', "public"."mantle_ws_kind"(w.id)`;

/** What WS_LOOK_COLUMNS reads. */
export type LookRow = {
  look_color: string | null;
  look_icon: string | null;
  look_kind: string | null;
};

/** A look as it goes out: a known tint, a drawable icon and a known kind,
 *  each else its default (null, null, 'other'). */
export function workspaceLook(
  color: unknown,
  icon: unknown,
  kind: unknown,
): Required<WorkspaceLook> {
  return {
    color: isAppTint(color) ? color : null,
    icon: (typeof icon === 'string' && projectAppIcon(icon)) || null,
    kind: KINDS.includes(kind as WorkspaceKind) ? (kind as WorkspaceKind) : 'other',
  };
}

/** The look of a row read with WS_LOOK_COLUMNS. */
export function lookOfRow(r: LookRow): Required<WorkspaceLook> {
  return workspaceLook(r.look_color, r.look_icon, r.look_kind);
}
