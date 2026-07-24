import { SetPageTitle } from '@/components/layout/page-title';
import { PdfPasswordsClient } from './pdf-passwords-client';

/**
 * PDF passwords: data-free. PdfPasswordsClient fetches the list from
 * GET /api/pdf-passwords and mutates via POST /api/pdf-passwords +
 * DELETE /api/pdf-passwords/[id].
 */
export default async function PdfPasswordsSettingsPage() {
  return (
    <>
      <SetPageTitle title="PDF passwords" />
      <PdfPasswordsClient />
    </>
  );
}
