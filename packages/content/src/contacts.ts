/**
 * Contacts surface. A contact is a `nodes` row of type='contact' — the people
 * (and organisations) the user's agents are allowed to email and message.
 *
 *   nodes.title        derived display name (first + last, or just first for orgs)
 *   nodes.data         { first_name, last_name, email, country_code, cell, description }
 *   nodes.tags         freeform
 *
 * Lives under the `contacts` ltree root, lazy-created on first write. Because
 * it's a node, the brain auto-ingests via the `node_ingested` trigger →
 * extractor reads name + description and builds summary + embedding + facts on
 * the contact's entity — so search_nodes(type='contact', q='Modular') just works.
 *
 * Gate role: `contactEmails(ownerId)` returns every contact's normalised email;
 * `email_send`/`email_page` enforce "recipient ∈ own_accounts ∪ contact_emails"
 * once the contacts list is non-empty. See docs/contacts.md.
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, type Node } from '@mantle/db';
import {
  deriveContactTitle,
  digitsOnly,
  formatCell,
  isPlausibleEmail,
  normalizeCountryCode,
  normalizeEmail,
  toE164,
  type ContactCounts,
  type ContactLastAt,
  type ContactMethod,
  type ContactRow,
  type CreateContactInput,
  type UpdateContactInput,
} from './contacts-format';

export const CONTACTS_ROOT_LABEL = 'contacts';

// Re-export the pure module's surface so existing importers of `@mantle/content`
// (server + the unit tests) keep working unchanged. Client code that wants to
// avoid pulling in @mantle/db should import from `@mantle/content/contacts-format`
// directly — that's the leaf path with no DB transitively.
export {
  deriveContactTitle,
  digitsOnly,
  formatCell,
  isPlausibleEmail,
  normalizeCountryCode,
  normalizeEmail,
  toE164,
  type ContactCounts,
  type ContactLastAt,
  type ContactMethod,
  type ContactRow,
  type CreateContactInput,
  type UpdateContactInput,
} from './contacts-format';

// ─── row + CRUD ────────────────────────────────────────────────────────────

function projectCounts(raw: unknown): ContactCounts {
  if (!raw || typeof raw !== 'object') return {};
  const out: ContactCounts = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}
function projectLastAt(raw: unknown): ContactLastAt {
  if (!raw || typeof raw !== 'object') return {};
  const out: ContactLastAt = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

function rowOf(n: Node): ContactRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const firstName = typeof d.first_name === 'string' ? d.first_name : '';
  const lastName = typeof d.last_name === 'string' ? d.last_name : '';
  const email = typeof d.email === 'string' ? d.email : '';
  const countryCode = typeof d.country_code === 'string' ? d.country_code : '';
  const cell = typeof d.cell === 'string' ? d.cell : '';
  const description = typeof d.description === 'string' ? d.description : '';
  return {
    id: n.id,
    title: n.title,
    firstName,
    lastName,
    email,
    countryCode,
    cell,
    cellE164: toE164(countryCode, cell),
    cellFormatted: formatCell(countryCode, cell),
    description,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    contactCounts: projectCounts(d.contact_counts),
    lastContactedAt: projectLastAt(d.last_contacted_at),
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Contacts',
      slug: CONTACTS_ROOT_LABEL,
      path: CONTACTS_ROOT_LABEL,
      data: {
        description:
          "People + organisations the agents may email/message. Acts as the email allowlist: once non-empty, sending is restricted to these recipients plus the user's own account addresses.",
      },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

type ListContactsOpts = { query?: string; tag?: string };

function contactConds(ownerId: string, opts: ListContactsOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'first_name' ilike ${q}`,
      sql`${nodes.data}->>'last_name' ilike ${q}`,
      sql`${nodes.data}->>'email' ilike ${q}`,
      sql`${nodes.data}->>'description' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listContacts(
  ownerId: string,
  opts: ListContactsOpts & { limit?: number; offset?: number } = {},
): Promise<ContactRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...contactConds(ownerId, opts)))
    .orderBy(desc(nodes.updatedAt))
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map(rowOf);
}

export async function countContacts(
  ownerId: string,
  opts: ListContactsOpts = {},
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...contactConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function getContact(ownerId: string, id: string): Promise<ContactRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
    .limit(1);
  return row ? rowOf(row) : null;
}

/** Every distinct non-empty contact email for the owner, lower-cased. Drives
 *  the email_send / email_page allowlist gate. Cheap — one indexed scan. */
export async function contactEmails(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ email: sql<string>`${nodes.data}->>'email'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'contact'),
        sql`${nodes.data}->>'email' is not null and ${nodes.data}->>'email' <> ''`,
      ),
    );
  const set = new Set<string>();
  for (const r of rows) {
    const e = normalizeEmail(r.email ?? '');
    if (e) set.add(e);
  }
  return [...set];
}

/**
 * Map the given lower-cased email addresses to contact ids for an owner. Used
 * by the send path: gather the set of recipients that map to known contacts so
 * each one's counter gets bumped on success. Returns Map<email_lc, contact_id>.
 * Unknown emails are simply absent from the map.
 */
export async function findContactsByEmails(
  ownerId: string,
  emails: string[],
): Promise<Map<string, string>> {
  const wanted = new Set(emails.map((e) => normalizeEmail(e)).filter(Boolean));
  if (wanted.size === 0) return new Map();
  const rows = await db
    .select({ id: nodes.id, email: sql<string>`${nodes.data}->>'email'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'contact'),
        sql`lower(${nodes.data}->>'email') = ANY(${[...wanted]}::text[])`,
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    const e = normalizeEmail(r.email ?? '');
    if (e && wanted.has(e)) out.set(e, r.id);
  }
  return out;
}

/**
 * Bump the per-method outbound counter and last-contacted timestamp on a
 * contact. Atomic — one SQL update with `jsonb_set` chained, so concurrent
 * sends don't lose increments. Owner-scoped; no-op if the id isn't this
 * owner's contact (returns false). Safe to call from a fire-and-forget context
 * — the caller decides whether to await.
 *
 * The data shape it maintains:
 *   data.contact_counts    = { email: N, sms: M, ... }
 *   data.last_contacted_at = { email: ISO, sms: ISO, ... }
 * Missing keys read as zero / never (mirrors projectCounts/projectLastAt).
 */
export async function recordContactSent(
  ownerId: string,
  contactId: string,
  method: ContactMethod | string,
): Promise<boolean> {
  const m = method.trim();
  if (!m) return false;
  const nowIso = new Date().toISOString();
  // Chained jsonb_set: bump counts[method] (default 0 + 1), set last_at[method].
  // coalesce keeps `data` a valid object even on rows that somehow lack one.
  const countsPath = `{contact_counts,${m}}`;
  const lastAtPath = `{last_contacted_at,${m}}`;
  const result = await db.execute(sql`
    update ${nodes}
    set data = jsonb_set(
                 jsonb_set(
                   -- ensure both parent objects exist before jsonb_set descends into them
                   jsonb_set(
                     jsonb_set(
                       coalesce(data, '{}'::jsonb),
                       '{contact_counts}',
                       coalesce(data->'contact_counts', '{}'::jsonb),
                       true
                     ),
                     '{last_contacted_at}',
                     coalesce(data->'last_contacted_at', '{}'::jsonb),
                     true
                   ),
                   ${countsPath}::text[],
                   to_jsonb(coalesce((data->'contact_counts'->>${m})::int, 0) + 1),
                   true
                 ),
                 ${lastAtPath}::text[],
                 to_jsonb(${nowIso}::text),
                 true
               ),
        updated_at = now()
    where id = ${contactId}
      and owner_id = ${ownerId}
      and type = 'contact'
  `);
  // postgres-js `execute` returns the underlying rows; checking count needs the
  // result shape — `result.count` works for INSERTs/UPDATEs in postgres-js.
  return (result as unknown as { count?: number }).count
    ? ((result as unknown as { count: number }).count > 0)
    : true; // optimistic — even if drivers vary, we won't pretend it failed.
}

/** Validate + normalise. Returns the canonical shape we'll store, or throws on
 *  bad input (caller surfaces). Empty fields are kept as empty strings so the
 *  jsonb shape is stable. */
function normalizeContactInput(input: CreateContactInput) {
  const firstName = (input.firstName ?? '').trim();
  const lastName = (input.lastName ?? '').trim();
  const email = normalizeEmail(input.email ?? '');
  const description = (input.description ?? '').slice(0, 4000);
  const countryCode = input.countryCode ? normalizeCountryCode(input.countryCode) : '';
  const cell = input.cell ? digitsOnly(input.cell) : '';

  if (!firstName && !lastName && !email && !cell) {
    throw new Error('Need at least one of: first name, last name, email, or cell.');
  }
  if (email && !isPlausibleEmail(email)) {
    throw new Error(`'${email}' doesn't look like a valid email address.`);
  }
  if (input.countryCode && !countryCode) {
    throw new Error(`'${input.countryCode}' is not a recognised country code (e.g. +27).`);
  }
  if (cell && !countryCode) {
    throw new Error('Country code is required when a cell number is set.');
  }
  return { firstName, lastName, email, countryCode, cell, description };
}

export async function createContact(
  ownerId: string,
  input: CreateContactInput,
): Promise<ContactRow> {
  const fields = normalizeContactInput(input);
  await ensureRoot(ownerId);
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'contact',
      title: deriveContactTitle({
        firstName: fields.firstName,
        lastName: fields.lastName,
        email: fields.email,
        countryCode: fields.countryCode,
        cell: fields.cell,
      }),
      path: CONTACTS_ROOT_LABEL,
      data: {
        first_name: fields.firstName,
        last_name: fields.lastName,
        email: fields.email,
        country_code: fields.countryCode,
        cell: fields.cell,
        description: fields.description,
      },
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createContact: insert returned no row');
  return rowOf(row);
}

export async function updateContact(
  ownerId: string,
  id: string,
  input: UpdateContactInput,
): Promise<ContactRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
    .limit(1);
  if (!node) return null;

  const oldData = (node.data ?? {}) as Record<string, unknown>;
  // Merge in patch: any field the caller didn't set falls back to the stored
  // value so a single-field edit (e.g. update cell only) doesn't blank the rest.
  const merged: CreateContactInput = {
    firstName: input.firstName ?? (typeof oldData.first_name === 'string' ? oldData.first_name : ''),
    lastName: input.lastName ?? (typeof oldData.last_name === 'string' ? oldData.last_name : ''),
    email: input.email ?? (typeof oldData.email === 'string' ? oldData.email : ''),
    countryCode:
      input.countryCode ?? (typeof oldData.country_code === 'string' ? oldData.country_code : ''),
    cell: input.cell ?? (typeof oldData.cell === 'string' ? oldData.cell : ''),
    description:
      input.description ?? (typeof oldData.description === 'string' ? oldData.description : ''),
  };
  const fields = normalizeContactInput(merged);

  // Did any extractor-visible field change? If so the prior summary/embedding
  // is stale — clear them so the re-extract on UPDATE writes a fresh pass.
  // The INSERT trigger doesn't fire on UPDATE, so we explicitly re-notify below.
  const visibleChanged =
    fields.firstName !== (typeof oldData.first_name === 'string' ? oldData.first_name : '') ||
    fields.lastName !== (typeof oldData.last_name === 'string' ? oldData.last_name : '') ||
    fields.email !== (typeof oldData.email === 'string' ? oldData.email : '') ||
    fields.description !== (typeof oldData.description === 'string' ? oldData.description : '');

  const newData: Record<string, unknown> = {
    ...oldData,
    first_name: fields.firstName,
    last_name: fields.lastName,
    email: fields.email,
    country_code: fields.countryCode,
    cell: fields.cell,
    description: fields.description,
  };
  if (visibleChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }

  const [updated] = await db
    .update(nodes)
    .set({
      title: deriveContactTitle({
        firstName: fields.firstName,
        lastName: fields.lastName,
        email: fields.email,
        countryCode: fields.countryCode,
        cell: fields.cell,
      }),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      ...(visibleChanged ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('updateContact: update returned no row');
  if (visibleChanged) {
    // Re-fire the extractor so summary/embedding/facts catch up. The INSERT
    // trigger only fires on INSERT, so this is the explicit refresh.
    const { notifyNodeIngested } = await import('@mantle/db');
    await notifyNodeIngested(id);
  }
  return rowOf(updated);
}

export async function deleteContact(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id));
  return true;
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
