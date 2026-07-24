import { SetPageTitle } from '@/components/layout/page-title';
import { ConfigClient } from './config-client';

/**
 * Config sanity checker (read-only). Diffs the brain's live agent/skill/tool-
 * group/worker config against the shipped manifest template, anchored on the
 * effective persona, and shows per-item what is OK / missing / modified / added,
 * with per-item + commit-all adoption. Data-free: ConfigClient fetches the diff
 * report over HTTP (GET /api/config) and mutates via /api/config/adopt(-all).
 */
export default async function ConfigPage() {
  return (
    <>
      <SetPageTitle title="Config" />
      <ConfigClient />
    </>
  );
}
