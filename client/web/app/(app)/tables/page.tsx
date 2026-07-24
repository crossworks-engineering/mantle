import { Suspense } from 'react';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { TablesShell } from './tables-shell';

/**
 * /tables — master-detail (auth gate only). The list (paginated/filtered/sorted),
 * tag facets, and the selected table's full grid are client-fetched via
 * `/api/tables(/[id])` (Phase 2 · Task 4), keyed off the URL params
 * (`q`/`tag`/`sort`/`page`/`selected`) which `TablesShell` reads with
 * useSearchParams — hence the Suspense boundary.
 */
export default async function TablesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <TablesShell />
    </Suspense>
  );
}
