'use client';

/**
 * /contacts master-detail. List on the left (340px accent cards), form on the
 * right. URL-driven search + pagination via useListNav; selection via ?id=.
 * Saving the form PATCHes /api/contacts/[id]; the "New" button POSTs an empty
 * contact and navigates to it so the form is the same surface for create+edit.
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import { Mail, Phone, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
// IMPORTANT: import from the *leaf* `contacts-format` subpath, NOT the
// `@/lib/contacts` re-export — that one barrels through `@mantle/content` →
// `@mantle/db` → `postgres` (Node-only `fs`), which Next can't ship to the
// browser. The DB-using server code keeps using @/lib/contacts as before.
import {
  formatCell,
  normalizeCountryCode,
  type ContactRow,
} from '@mantle/content/contacts-format';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';

export function ContactsClient({
  contacts,
  total,
  page,
  pageSize,
  query,
  selected,
}: {
  contacts: ContactRow[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
  selected: ContactRow | null;
}) {
  const { go, pending } = useListNav();
  const [q, setQ] = useState(query);

  // The form state mirrors `selected` and resets whenever the selection
  // changes (server-side nav → new props). Local edits stay client-only until
  // Save runs.
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
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
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
                    'block w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                    selected?.id === c.id
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50',
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
  const { go } = useListNav();
  const [pending, start] = useTransition();
  const onClick = () => {
    start(async () => {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Create a fully-empty draft — the form opens to blank fields. Empty
        // contacts are inert (no email ⇒ not in the allowlist, no recipient
        // match ⇒ no counter bumps) until the user fills them in.
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as { contact?: ContactRow; error?: string };
      if (!res.ok || !body.contact) {
        toast.error(body.error ?? 'Could not create contact');
        return;
      }
      go({ id: body.contact.id, page: null });
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
  const { go } = useListNav();
  const [firstName, setFirstName] = useState(contact.firstName);
  const [lastName, setLastName] = useState(contact.lastName);
  const [company, setCompany] = useState(contact.company);
  const [email, setEmail] = useState(contact.email);
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
    setEmail(contact.email);
    setCountryCode(contact.countryCode || '+27');
    setCell(contact.cell);
    setDescription(contact.description);
    setTags(contact.tags);
  }, [contact]);

  const cellPreview = useMemo(() => formatCell(countryCode, cell), [countryCode, cell]);

  const onSave = () => {
    start(async () => {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          first_name: firstName,
          last_name: lastName,
          company,
          email,
          country_code: normalizeCountryCode(countryCode) || countryCode,
          cell,
          description,
          tags,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { contact?: ContactRow; error?: string };
      if (!res.ok || !body.contact) {
        toast.error(body.error ?? 'Could not save');
        return;
      }
      toast.success('Saved');
      // Refresh the SSR list (so the row's display name updates if it changed).
      go({});
    });
  };

  const onDelete = () => {
    startDelete(async () => {
      const res = await fetch(`/api/contacts/${contact.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not delete');
        return;
      }
      toast.success('Deleted');
      setConfirmDelete(false);
      // Drop the id so the server page auto-selects the next one (or empty).
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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmDelete(true)}
          title="Delete contact"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 aria-hidden />
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
        <Label htmlFor="email">Email address</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="orders@modular.co.za"
          autoComplete="off"
        />
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

      <div className="flex items-center gap-2">
        <Button onClick={onSave} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
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
