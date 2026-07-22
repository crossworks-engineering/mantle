import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@/components/ui/spinner';
import { FormulasClient } from './formulas-client';

/**
 * /formulas — auth gate only. The list (filtered by search/standard/tag), the
 * deep-linked selected formula and the evaluator panel are all client-fetched
 * via `/api/formulas(/[id])`, keyed off the URL params which `FormulasClient`
 * reads with useSearchParams — hence the Suspense boundary.
 */
export default async function FormulasPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Formulas" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <FormulasClient />
      </Suspense>
    </>
  );
}
