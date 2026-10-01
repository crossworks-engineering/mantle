// FOLDERS: where pages and notes sit in the item tree.
//
// Every workspace screen on main has one folder tree per kind (docs/
// folder-tree.md): folders with an icon and a colour, at most three levels
// deep, and items that are never parents. A fresh brain with 120 notes at the
// top level looks like nobody works there, so the demo files its pages and
// notes the way the studio would: one folder per project, in the project's
// colour, with a second level where the work has one.
//
// The modules keep writing `branch` on every node (the project the item
// belongs to). This module turns a branch into a folder, so no content module
// has to know the folder ids. A node that already names its folder
// (`meta.folder`, the handbook does) is left alone. A branch with no folder
// here stays at the top level: a real tree has unsorted items too.
//
// Two folders are shared, to show the share levels:
//   - the Studio Handbook (pages) is shared with the TEAM; handbook.mjs owns it
//   - PUMPHOUSE / Procedures (pages) is shared with CLIENTS: the issued
//     procedure revisions are what the client approves and works to
// A share reaches everything in the folder and below it.
//
// WHAT IS SHARED IS PINNED, here and in the test. A share is the one thing in
// this tree that changes who can read an item, and nothing downstream could
// tell a wrong one from a right one: the seeder confirms the count the brain
// shows, and the client report is acknowledged as it stands. So gen.mjs
// writes on each shared folder how many items and folders the share must
// reach (`expect`), the seeder refuses to confirm any other count, and
// verify.ts asserts the exact numbers. To share another folder, change it
// here AND in the test; a `share` added anywhere else fails both.

// Tables a colleague works in, shown to the team by their own LEVEL (there is
// no shared tables folder). By generator table id.
export const TEAM_TABLE_IDS = ['traffic-risk-register', 'pump-snag-list'];

const PROJECTS = [
  { key: 'pumphouse', name: 'PUMPHOUSE', icon: 'lucide:droplets', color: 'blue' },
  { key: 'storefront', name: 'STOREFRONT', icon: 'lucide:store', color: 'amber' },
  { key: 'island', name: 'ISLAND', icon: 'lucide:zap', color: 'green' },
];

// kind → branch → folder id. A branch not listed stays at the top level.
const PLACE = {
  pages: {
    'work.pumphouse': 'fld-pages-pumphouse',
    'work.pumphouse.procedures': 'fld-pages-pumphouse-procedures',
    'work.storefront': 'fld-pages-storefront',
    'work.island': 'fld-pages-island',
    'work.island.research': 'fld-pages-island',
  },
  notes: {
    'work.pumphouse': 'fld-notes-pumphouse',
    'work.pumphouse.site': 'fld-notes-pumphouse-site',
    'work.storefront': 'fld-notes-storefront',
    'work.storefront.stores': 'fld-notes-storefront-stores',
    'work.island': 'fld-notes-island',
    'studio': 'fld-notes-studio',
    'studio.ops': 'fld-notes-studio-ops',
  },
};

const TREE_OF = { page: 'pages', note: 'notes' };

/** The folder id a node goes in, or null for the top level. */
export function folderFor(node) {
  const kind = TREE_OF[node.kind];
  if (!kind) return null;
  return PLACE[kind][node.branch] ?? null;
}

// One page per listed folder ends in `[Folder index](folder:here)`: the block
// lists the pages of the folder the page itself sits in, live.
export const INDEX_HERE = {
  'island-brief': 'Everything else in the study, live from this folder:',
  'store-tranche-overview': 'The other tranche 2 pages, live from this folder:',
};

export function generate() {
  const folders = [];
  for (const kind of ['pages', 'notes']) {
    for (const p of PROJECTS) {
      folders.push({ id: `fld-${kind}-${p.key}`, kind, parent: null, name: p.name, icon: p.icon, color: p.color });
    }
  }
  folders.push(
    { id: 'fld-pages-pumphouse-procedures', kind: 'pages', parent: 'fld-pages-pumphouse', name: 'Procedures', icon: 'lucide:scroll-text', color: 'cyan', share: 'client' },
    { id: 'fld-notes-pumphouse-site', kind: 'notes', parent: 'fld-notes-pumphouse', name: 'Site visits', icon: 'lucide:hard-hat', color: 'orange' },
    { id: 'fld-notes-storefront-stores', kind: 'notes', parent: 'fld-notes-storefront', name: 'Store surveys', icon: 'lucide:map-pin', color: 'orange' },
    { id: 'fld-notes-studio', kind: 'notes', parent: null, name: 'Studio', icon: 'lucide:briefcase', color: 'violet' },
    { id: 'fld-notes-studio-ops', kind: 'notes', parent: 'fld-notes-studio', name: 'Ops', icon: 'lucide:settings-2', color: 'slate' },
  );
  return { folders };
}
