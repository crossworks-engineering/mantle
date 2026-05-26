import { requireOwner } from '@/lib/auth';
import { countContacts, getContact, listContacts } from '@/lib/contacts';
import { SetPageTitle } from '@/components/layout/page-title';
import { ContactsClient } from './contacts-client';

const PAGE_SIZE = 50;

/**
 * /contacts — master-detail. Contacts are the index of people Saskia may email
 * (and later SMS). Adding the first contact engages the email allowlist (see
 * builtins-email.ts blockedRecipients).
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; id?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;

  const [contacts, total] = await Promise.all([
    listContacts(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countContacts(user.id, { query }),
  ]);

  // Auto-select first row when no explicit id; if the requested id isn't in
  // the current page slice, fall back to the first one (same heuristic the
  // other master-detail pages use).
  const requestedId = sp.id?.trim() || undefined;
  const selectedId = requestedId ?? contacts[0]?.id;
  const selected = selectedId ? await getContact(user.id, selectedId) : null;

  return (
    <>
      <SetPageTitle title="Contacts" />
      <ContactsClient
        contacts={contacts}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        query={query ?? ''}
        selected={selected}
      />
    </>
  );
}
