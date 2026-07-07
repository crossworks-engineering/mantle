import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { ToolValidationClient } from './tool-validation-client';

/** Debug → Tool validation: the central arg-validator's warn-mode telemetry
 *  (what enforce would have bounced). Data-free — the client fetches
 *  GET /api/debug/tool-validation. */
export default async function DebugToolValidationPage() {
  await requireOwner();

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Tool validation" />
      <ToolValidationClient />
    </div>
  );
}
