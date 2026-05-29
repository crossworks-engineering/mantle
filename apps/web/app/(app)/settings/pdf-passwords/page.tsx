import { requireOwner } from '@/lib/auth';
import { listPdfPasswords } from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { PdfPasswordsClient } from './pdf-passwords-client';

export default async function PdfPasswordsSettingsPage() {
  const user = await requireOwner();
  const passwords = await listPdfPasswords(user.id);
  return (
    <>
      <SetPageTitle title="PDF passwords" />
      <PdfPasswordsClient initial={passwords} />
    </>
  );
}
