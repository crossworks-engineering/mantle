/**
 * A route's endpoint as the fleet compares it (docs/control-center.md,
 * "Fleet writes"): a short hash of its base URL, not the URL itself. It
 * tells two routes apart; it does not hide a URL someone can guess (a
 * reader of the matrix can hash likely URLs and compare). `''` is the
 * provider's own endpoint
 * (no base URL). Two routes on one provider name with different base URLs
 * serve different models, so a model is copied only between routes with
 * the same print.
 */
import { createHash } from 'node:crypto';
import { CONTROL_ENDPOINT } from '@mantle/db/schema';

export function endpointPrint(baseUrl: string | null | undefined): string {
  const url = (baseUrl ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (!url) return '';
  const print = createHash('sha256').update(url).digest('hex').slice(0, 12);
  return CONTROL_ENDPOINT.test(print) ? print : '';
}
