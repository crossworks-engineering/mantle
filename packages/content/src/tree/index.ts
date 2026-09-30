/**
 * The item tree, brain side (docs/folder-tree.md): one navigation for every
 * workspace kind. Reads (a folder's page, search, the reader's marks) and
 * writes (folders and moves), with the kind differences kept in one place.
 */
export { READER_TREE_KINDS, TREE_LIVE_KINDS, isTreeLiveKind } from './kinds';
export { ensureKindRoot } from './node-ops';
export { reconcileAppMarks, reconcileAppNav } from './apps-nav';
export {
  NOTES_ASSISTANT_PATH,
  NOTES_AUTO_FILED_PATH,
  ensureNotesAssistantFolder,
  reconcileNotesAutoFiled,
} from './notes-auto-filed';
export { decodeTreeCursor, encodeTreeCursor, type TreeCursor } from './cursor';
export {
  listTreeFolders,
  listTreeTags,
  loadTreeFolder,
  searchTree,
  treeCrumbsFor,
  treeFolderById,
  treePageLimit,
} from './read';
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
  type TreeWriteOpts,
  type TreeMoveResult,
} from './write';
export {
  TreeVisibilityError,
  liftDiff,
  moveFolderDiff,
  moveItemsDiff,
  shareDiff,
  type VisibilityDiff,
} from './visibility';
export { guardFileTo, guardFolderTo, guardNewFileIn, type ConfirmOpts } from './files-guard';
export {
  clientTreeFolderPage,
  clientTreeSearch,
  loadReaderTreeFolder,
  searchReaderTree,
  type TreeReader,
} from './reader';
export {
  loadMemberTreeFolder,
  memberView,
  searchMemberTree,
  storedPathOf,
  treePathOf,
  type MemberTreeScope,
  type MemberView,
} from './member-tree';
export {
  createMemberFolder,
  deleteMemberFolder,
  memberFilingPath,
  moveMemberItems,
  updateMemberFolder,
  type MemberFolderPatch,
} from './member-tree-write';
