// FOLDERS: the item tree, and the four sharing levels shown in it.
//
// Every workspace that can share (Files, Notes, Pages, Tables, Draw,
// Formulas, Apps) gets the same three folders, so a visitor learns the
// pattern once and sees it everywhere:
//
//   Private            admin only: Alex's own drafts
//   Team               shared with the team (member logins)
//   Client: Meridian   shared with clients (the one client login)
//
// and the fourth level, public, is one item at the top level with an open
// link (the seeder makes the link after the folder shares). A folder share
// cannot be public, so the public item is what shows that level.
//
// A content item says which level it belongs to with `tier`; gen.mjs turns
// that into a folder (or, for `public`, the top level plus a link). Kinds
// that can never go below admin (tasks, events, contacts, secrets) get
// project folders instead, because a tree with everything at the top level
// looks like nobody works there.
//
// WHAT IS SHARED IS COUNTED. gen.mjs writes on each shared folder how many
// items the share must reach (`expect`), the seeder confirms a share only for
// exactly that count, and verify.ts asserts the totals. Embeds stay inside
// their own tier (the test pins it), so a share never reaches through an
// image into another folder.
import { world } from '../lib/world.mjs';

/** Node type → its tree kind, for the kinds that can share. */
export const TREE_OF = {
  page: 'pages', note: 'notes', file: 'files', table: 'tables',
  draw: 'draw', formula: 'formulas', app: 'apps',
};
export const TIERS = ['private', 'team', 'client', 'public'];

/** The folder a tier's items sit in, or null (public items sit at the top). */
export function tierFolder(nodeType, tier) {
  const kind = TREE_OF[nodeType];
  if (!kind) throw new Error(`folders: ${nodeType} cannot carry a tier`);
  if (!TIERS.includes(tier)) throw new Error(`folders: unknown tier '${tier}'`);
  return tier === 'public' ? null : `fld-${kind}-${tier}`;
}

/** Project folders for the kinds that stay admin. */
export const PROJECT_FOLDERS = {
  tasks: { pumphouse: 'fld-tasks-ps3', island: 'fld-tasks-standby' },
  events: { pumphouse: 'fld-events-ps3', island: 'fld-events-standby' },
  contacts: { 'harbour-labs': 'fld-contacts-harbour', meridian: 'fld-contacts-meridian' },
  secrets: { pumphouse: 'fld-secrets-ps3', studio: 'fld-secrets-studio' },
};

export function generate() {
  const folders = [];
  const look = world.access.folders;
  // Files first: the seeder shares in this order, and a page's images must
  // already be at the page's level when the page folder is shared.
  for (const kind of ['files', 'tables', 'draw', 'formulas', 'apps', 'pages', 'notes']) {
    for (const tier of ['private', 'team', 'client']) {
      const f = look[tier];
      folders.push({
        id: `fld-${kind}-${tier}`, kind, parent: null, name: f.name, icon: f.icon, color: f.color,
        ...(f.share ? { share: f.share } : {}),
      });
    }
  }
  const project = [
    ['tasks', 'fld-tasks-ps3', 'PS3 telemetry', 'lucide:radio-tower', 'blue'],
    ['tasks', 'fld-tasks-standby', 'Standby power', 'lucide:battery-charging', 'green'],
    ['events', 'fld-events-ps3', 'PS3 telemetry', 'lucide:radio-tower', 'blue'],
    ['events', 'fld-events-standby', 'Standby power', 'lucide:battery-charging', 'green'],
    ['contacts', 'fld-contacts-harbour', 'Harbour Labs', 'lucide:building-2', 'slate'],
    ['contacts', 'fld-contacts-meridian', 'Meridian Waterworks', 'lucide:droplets', 'sky'],
    ['secrets', 'fld-secrets-ps3', 'PS3 site', 'lucide:radio-tower', 'blue'],
    ['secrets', 'fld-secrets-studio', 'Studio', 'lucide:briefcase', 'violet'],
  ];
  for (const [kind, id, name, icon, color] of project) folders.push({ id, kind, parent: null, name, icon, color });
  return { folders };
}
