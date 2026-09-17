/** Re-export from the shared workspace package. See @mantle/content. */
export {
  FORMULA_ROOT_LABEL,
  FormulaSpecError,
  isFormulaSpecError,
  listFormulas,
  countFormulas,
  listFormulaStandards,
  listFormulaSpecIds,
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
} from '@mantle/content-core/formula-spec';

export { evaluateSpec, type EvalResult, type TraceStep } from '@mantle/content-core/formula-eval';

export {
  signatureOf,
  signatureForTarget,
  signatureLine,
  type TargetSignature,
  type SignatureInput,
  type SignatureBranch,
} from '@mantle/content-core/formula-signature';

export {
  checkDimensions,
  normaliseUnit,
  type DimensionIssue,
} from '@mantle/content-core/formula-dimensions';
