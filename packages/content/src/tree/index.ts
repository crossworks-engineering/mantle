/**
 * The item tree, brain side (docs/folder-tree.md): one navigation for every
 * workspace kind. Reads (a folder's page, search, the reader's marks) and
 * writes (folders and moves), with the kind differences kept in one place.
 */
export { TREE_LIVE_KINDS, isTreeLiveKind } from './kinds';
export { decodeTreeCursor, encodeTreeCursor, type TreeCursor } from './cursor';
export { loadTreeFolder, searchTree, treeCrumbsFor, treeFolderById, treePageLimit } from './read';
export {
  TREE_MARKS_LIST_MAX,
  listTreeMarks,
  recordItemOpened,
  setItemPinned,
  type PinResult,
} from './marks';
export {
  TREE_CHANGED_CHANNEL,
  TreeError,
  notifyTreeChanged,
  createTreeFolder,
  deleteTreeFolder,
  moveTreeItems,
  updateTreeFolder,
  type TreeFolderPatch,
  type TreeMoveResult,
} from './write';
