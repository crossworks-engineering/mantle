/** Re-export from the shared workspace package. See @mantle/content. */
export {
  FORMULA_ROOT_LABEL,
  FormulaSpecError,
  isFormulaSpecError,
  listFormulas,
  countFormulas,
  getFormula,
  readFormulaSpec,
  createFormula,
  updateFormula,
  deleteFormula,
  type FormulaRow,
  type CreateFormulaInput,
  type UpdateFormulaInput,
} from '@mantle/content/formulas';

export {
  parseFormulaSpec,
  checkLookupCoverage,
  type FormulaSpec,
  type FormulaValue,
  type CoverageGap,
} from '@mantle/content/formula-spec';

export { evaluateSpec, type EvalResult, type TraceStep } from '@mantle/content/formula-eval';

export {
  checkDimensions,
  normaliseUnit,
  type DimensionIssue,
} from '@mantle/content/formula-dimensions';
