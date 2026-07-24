import { redirect } from 'next/navigation';

/**
 * The table editor now lives in the master-detail shell at /tables (resizable,
 * collapsible list on the left, grid on the right). Keep this route as a
 * permanent deep-link → it just selects the table in the shell.
 */
export default async function TableByIdRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/tables?selected=${encodeURIComponent(id)}`);
}
