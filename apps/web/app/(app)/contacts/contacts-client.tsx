'use client';

/**
 * /contacts master-detail. List on the left (340px accent cards), form on the
 * right. URL-driven search + pagination via useListNav; selection via ?id=.
 * Saving the form PATCHes /api/contacts/[id]; the "New" button POSTs an empty
 * contact and navigates to it so the form is the same surface for create+edit.
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Phone, Plus, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/toast';
import { TagInput } from '@/components/tag-input';
import { ListPager } from '@/components/layout/list-pager';
import { useListNav } from '@/lib/use-list-nav';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
// IMPORTANT: import from the *leaf* `contacts-format` subpath, NOT the
// `@/lib/contacts` re-export — that one barrels through `@mantle/content` →
// `@mantle/db` → `postgres` (Node-only `fs`), which Next can't ship to the
// browser. The DB-using server code keeps using @/lib/contacts as before.
import {
  formatCell,
  hasIdentity,
  isPlausibleEmailOrDomain,
  normalizeCountryCode,
  type ContactRow,
} from '@mantle/content/contacts-format';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';

type ContactsListResponse = {
  contacts: ContactRow[];
  total: number;
  page: number;
  pageSize: number;
};

export function ContactsClient() {
  const searchParams = useSearchParams();
  const { go, pending } = useListNav();

  // URL is the source of truth (matches the old SSR page).
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const requestedId = searchParams.get('id')?.trim() || null;

  const listQuery = useQuery({
    queryKey: ['contacts', { q: query, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (page > 1) qs.set('page', String(page));
      const s = qs.toString();
      return apiFetch<ContactsListResponse>(`/api/contacts${s ? `?${s}` : ''}`);
    },
    placeholderData: (prev) => prev,
  });

  const contacts = listQuery.data?.contacts ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.pageSize ?? 50;

  // Selection defaults to the first row (master-detail convention); ?id wins. A
  // deep-linked id outside the current slice is fetched directly.
  const selectedId = requestedId ?? contacts[0]?.id ?? null;
  const selectedContactQuery = useQuery({
    queryKey: ['contacts', selectedId],
    queryFn: () =>
      apiFetch<{ contact: ContactRow }>(`/api/contacts/${selectedId}`).then((r) => r.contact),
    enabled: !!selectedId && !contacts.some((c) => c.id === selectedId),
  });
  const selected =
    (selectedId ? contacts.find((c) => c.id === selectedId) : null) ??
    (selectedContactQuery.data?.id === selectedId ? selectedContactQuery.data : null) ??
    null;

  const [q, setQ] = useState(query);

  if (listQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (listQuery.isError && !listQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          {listQuery.error instanceof Error ? listQuery.error.message : 'Failed to load contacts.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  // The form state (ContactForm) mirrors `selected` and resets when the
  // selection changes (it's keyed on selected.id). Local edits stay client-only
  // until Save runs.
  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[340px_1fr] md:gap-0">
      {/* ─── LIST ─────────────────────────────────────────────────────── */}
      <aside className="flex min-h-0 flex-col border-r border-border bg-muted/20">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go({ q: q || null, page: null });
              }}
              onBlur={() => {
                if (q !== query) go({ q: q || null, page: null });
              }}
              placeholder="Search contacts…"
              className="pl-8"
            />
          </div>
          <NewContactButton />
        </div>
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-thin p-3">
          {contacts.length === 0 ? (
            <li className="px-2 py-8 text-center text-sm text-muted-foreground">
              {query ? `No contacts match "${query}".` : 'No contacts yet. Click + to add one.'}
            </li>
          ) : (
            contacts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => go({ id: c.id })}
                  disabled={pending}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left text-sm transition-colors hover:bg-muted/50',
                    selected?.id === c.id && 'border-l-primary',
                  )}
                >
                  <div className="truncate font-medium">{c.title}</div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {/* Surface company on the secondary line — but only when
                        it's not already the title (i.e. a company-only contact
                        whose title IS the company). For person@company contacts
                        the title is the person and we show the company here. */}
                    {c.company && c.company !== c.title ? (
                      <span className="truncate">{c.company}</span>
                    ) : c.email ? (
                      <span className="truncate">{c.email}</span>
                    ) : null}
                    {c.contactCounts.email && c.contactCounts.email > 0 ? (
                      <span className="ml-auto whitespace-nowrap">
                        ✉ {c.contactCounts.email}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-border px-3 py-2">
          <ListPager
            total={total}
            page={page}
            pageSize={pageSize}
            pending={pending}
            onGo={(p) => go({ page: p === 1 ? null : p })}
          />
        </div>
      </aside>

      {/* ─── DETAIL / FORM ────────────────────────────────────────────── */}
      <main className="min-h-0 overflow-y-auto">
        {selected ? (
          <ContactForm key={selected.id} contact={selected} />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
            {contacts.length === 0
              ? 'Add your first contact. Saskia will then be able to email them.'
              : 'Pick a contact on the left.'}
          </div>
        )}
      </main>
    </div>
  );
}

function NewContactButton() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { go } = useListNav();
  const [pending, start] = useTransition();
  const onClick = () => {
    start(async () => {
      let contact: ContactRow;
      try {
        // Create a fully-empty draft — the form opens to blank fields. Empty
        // contacts are inert (no email ⇒ not in the allowlist, no recipient
        // match ⇒ no counter bumps) until the user fills them in.
        ({ contact } = await apiSend<{ contact: ContactRow }>('/api/contacts', 'POST', {}));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
        toast.error(e instanceof Error ? e.message : 'Could not create contact');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      go({ id: contact.id, page: null });
    });
  };
  return (
    <Button size="sm" variant="default" onClick={onClick} disabled={pending} title="Add a contact">
      <Plus aria-hidden />
    </Button>
  );
}

function ContactForm({ contact }: { contact: ContactRow }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { go } = useListNav();
  const [firstName, setFirstName] = useState(contact.firstName);
  const [lastName, setLastName] = useState(contact.lastName);
  const [company, setCompany] = useState(contact.company);
  const [emails, setEmails] = useState<string[]>(contact.emails.length ? contact.emails : ['']);
  const [countryCode, setCountryCode] = useState(contact.countryCode || '+27');
  const [cell, setCell] = useState(contact.cell);
  const [description, setDescription] = useState(contact.description);
  const [tags, setTags] = useState<string[]>(contact.tags);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const [pendingDelete, startDelete] = useTransition();

  // Reset the form whenever a different contact is selected. (`key` on the
  // parent already remounts us; this is belt-and-braces if the parent stops
  // passing key for any reason.)
  useEffect(() => {
    setFirstName(contact.firstName);
    setLastName(contact.lastName);
    setCompany(contact.company);
    setEmails(contact.emails.length ? contact.emails : ['']);
    setCountryCode(contact.countryCode || '+27');
    setCell(contact.cell);
    setDescription(contact.description);
    setTags(contact.tags);
  }, [contact]);

  const cellPreview = useMemo(() => formatCell(countryCode, cell), [countryCode, cell]);

  const onSave = () => {
    // Client-side identity check — mirrors the server-side guard in
    // updateContact, so the user gets immediate feedback instead of a
    // round-trip + a generic error. The server still enforces it; this is
    // just a UX shortcut.
    if (!hasIdentity({ firstName, lastName, company })) {
      toast.error('Add a first name, last name, or company before saving.');
      return;
    }
    start(async () => {
      try {
        await apiSend<{ contact: ContactRow }>(`/api/contacts/${contact.id}`, 'PATCH', {
          first_name: firstName,
          last_name: lastName,
          company,
          emails: emails.map((e) => e.trim()).filter(Boolean),
          country_code: normalizeCountryCode(countryCode) || countryCode,
          cell,
          description,
          tags,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
        toast.error(e instanceof Error ? e.message : 'Could not save');
        return;
      }
      toast.success('Saved');
      // Refetch the list so the row's display name updates if it changed (and
      // the selected-detail row, which is read from the list).
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
    });
  };

  const onDelete = () => {
    startDelete(async () => {
      try {
        await apiSend(`/api/contacts/${contact.id}`, 'DELETE');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
        toast.error(e instanceof Error ? e.message : 'Could not delete');
        return;
      }
      toast.success('Deleted');
      setConfirmDelete(false);
      // Refetch so the deleted row is gone, then drop the id so selection
      // falls back to the first contact (or empty).
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      go({ id: null });
    });
  };

  const emailCount = contact.contactCounts.email ?? 0;
  const lastEmailAt = contact.lastContactedAt.email;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{contact.title}</h2>
          <p className="text-xs text-muted-foreground">
            Added {formatDateTime(contact.createdAt)}
          </p>
        </div>
        {/* Match the events/notes/tasks pattern: ghost + destructive text +
            an explicit "Delete" label after the icon (icon-only was the
            inconsistent bit). */}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 aria-hidden /> Delete
        </Button>
      </header>

      {/* Activity summary — counts + last-contacted per method. */}
      {(emailCount > 0 || lastEmailAt) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <Mail className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="font-medium">{emailCount}</span>
            <span className="text-muted-foreground">email{emailCount === 1 ? '' : 's'} sent</span>
          </span>
          {lastEmailAt && (
            <span className="text-muted-foreground">
              last on <span className="text-foreground">{formatDateTime(lastEmailAt)}</span>
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="firstName">First name</Label>
          <Input id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Last name</Label>
          <Input id="lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="company">Company</Label>
        <Input
          id="company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Modular"
        />
        <p className="text-xs text-muted-foreground">
          Optional. Use the company alone for a supplier/org contact, or pair it with a person.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Email addresses</Label>
        <div className="space-y-2">
          {emails.map((entry, i) => {
            const invalid = entry.trim() !== '' && !isPlausibleEmailOrDomain(entry);
            return (
              <div key={i} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={entry}
                  onChange={(e) =>
                    setEmails((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                  }
                  placeholder={i === 0 ? 'orders@modular.co.za' : '@modular.co.za'}
                  autoComplete="off"
                  aria-invalid={invalid}
                  className={cn(invalid && 'border-destructive')}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove email"
                  onClick={() =>
                    setEmails((prev) => (prev.length === 1 ? [''] : prev.filter((_, j) => j !== i)))
                  }
                >
                  <X aria-hidden />
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEmails((prev) => [...prev, ''])}
        >
          <Plus aria-hidden /> Add email
        </Button>
        <p className="text-xs text-muted-foreground">
          Each line is a full address (<code>orders@modular.co.za</code>) or a whole-domain wildcard
          (<code>@modular.co.za</code>, trusting all mail from that domain). Mantle ingests mail from
          these into the brain; Saskia can email the plain addresses. Adding one backfills the last
          90 days.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Cell number</Label>
        <div className="grid grid-cols-[88px_1fr] gap-2">
          <Input
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            placeholder="+27"
            aria-label="Country code"
            className="font-mono"
          />
          <Input
            value={cell}
            onChange={(e) => setCell(e.target.value)}
            placeholder="760810774"
            aria-label="Cell number"
            inputMode="tel"
          />
        </div>
        {cellPreview && (
          <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Phone className="size-3" aria-hidden />
            <span className="font-mono">{cellPreview}</span>
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description — who is this, for the AI</Label>
        <Textarea
          id="description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Modular is the aluminium-profile supplier we use for printer projects. Sells 2020 and 3030 profiles."
        />
        <p className="text-xs text-muted-foreground">
          The brain indexes this — facts and entities land on this contact's identity,
          so Saskia can later answer &quot;who supplies aluminium profiles?&quot;.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Tags</Label>
        <TagInput value={tags} onChange={setTags} />
      </div>

      {/* Footer row: divider on top, Save floats right — same shape as the
          task/event forms (`flex justify-end gap-2 border-t pt-3`). */}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onSave} disabled={pending}>
          {pending ? 'Saving…' : 'Save contact'}
        </Button>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this contact?</AlertDialogTitle>
            <AlertDialogDescription>
              {contact.title} will be removed. Saskia will no longer be able to email this address
              (deleting also removes them from the email allowlist).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingDelete}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDelete}
              disabled={pendingDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pendingDelete ? 'Deleting…' : 'Delete contact'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
