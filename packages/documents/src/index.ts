/**
 * @mantle/documents: the documents engine (Gotenberg) behind the `documents`
 * service. M1 ships the wiring and the health probe; the route table, the
 * client and the input/output handling follow in the same branch.
 */
export {
  GOTENBERG_USERNAME,
  documentsAvailable,
  gotenbergAuthHeader,
  gotenbergConfig,
  type GotenbergConfig,
} from './config';
export { gotenbergHealth, type GotenbergHealth } from './health';
