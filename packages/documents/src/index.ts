/**
 * @mantle/documents: the documents engine (Gotenberg) behind the `documents`
 * service. One route table that mirrors the engine (routes.ts), one client
 * (client.ts), inputs as Mantle refs (inputs.ts), outputs landed by the
 * export rules (run.ts). Every surface (HTTP /api/v1/documents, the agent
 * tools, MCP, the app broker, the page export) calls runDocuments.
 */
export {
  GOTENBERG_USERNAME,
  documentsAvailable,
  gotenbergAuthHeader,
  gotenbergConfig,
  type GotenbergConfig,
} from './config';
export { gotenbergHealth, type GotenbergHealth } from './health';
export { printOrigin } from './print-origin';
export { RENDER_COOKIE_NAME, RENDER_TOKEN_TTL_SECONDS, buildRenderToken } from './render-token';
export { pngSize } from './png-size';
export {
  DOCUMENT_ROUTES,
  findRoute,
  routesOf,
  type DocumentsFamily,
  type ExtraInput,
  type MainInput,
  type OutputKind,
  type RouteDef,
} from './routes';
export { MANTLE_OWNED_FIELDS, PDFA_LEVELS, FACTURX_LEVELS, type Bookmark } from './schemas';
export { checkOptions, formValue } from './form';
export {
  DOCUMENTS_MAX_FILES,
  DOCUMENTS_MAX_INLINE_BYTES,
  DOCUMENTS_MAX_INPUT_BYTES,
  DOCUMENTS_MAX_TOTAL_BYTES,
  LIBREOFFICE_EXTENSIONS,
  resolveInputs,
  type DocumentsCaller,
  type DocumentsInputs,
  type InputDeps,
} from './inputs';
export {
  DocumentsBusyError,
  DocumentsFormError,
  DocumentsRenderError,
  DocumentsTooLargeError,
  DocumentsUnavailableError,
  callGotenberg,
  type GotenbergAnswer,
} from './client';
export {
  DRAW_WAIT_EXPRESSION,
  PAGE_WAIT_EXPRESSION,
  buildForm,
  extensionFor,
  outputStem,
  routeFor,
  runDocuments,
  type DocumentsCall,
  type DocumentsFile,
  type DocumentsResult,
} from './run';
