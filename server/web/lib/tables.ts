/** Re-export the Tables surface from the shared workspace package, so route
 *  handlers + server components import from one site. See @mantle/content. */
export {
  TABLES_ROOT_LABEL,
  listTables,
  countTables,
  listTableTags,
  getTable,
  createTable,
  updateTable,
  saveTableDraft,
  discardTableDraft,
  commitTable,
  deleteTable,
  applyTableOps,
  type ApplyTableOpsResult,
  type TableRow,
  type TableDetail,
  type TableVisibility,
  type TableSort,
  type CreateTableInput,
  type UpdateTableInput,
} from '@mantle/content/tables';

export { tableToText } from '@mantle/content/table-to-text';
