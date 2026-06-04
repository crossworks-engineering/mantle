import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { createContact, listContacts } from '@/lib/contacts';
import { enqueueBackfills } from '@mantle/email';
import { recordIngest } from '@mantle/tracing';

/**
 * /api/contacts — list + create. The contact list IS the email allowlist, so
 * a POST here effectively "extends Saskia's reach to this person".
 */

const CreateBody = z.object({
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
  emails: z.array(z.string().max(200)).max(50).optional(),
  /** @deprecated single-email shorthand; prefer `emails`. */
  email: z.string().max(200).optional(),
  country_code: z.string().max(8).optional(),
  cell: z.string().max(32).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(req: Request) {
  const user = await requireOwner();
  const url = new URL(req.url);
  const rows = await listContacts(user.id, {
    query: url.searchParams.get('q') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
  });
  return NextResponse.json({ contacts: rows });
}

export async function POST(req: Request) {
  const user = await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const { contact, addedEmails } = await createContact(user.id, {
      firstName: parsed.data.first_name,
      lastName: parsed.data.last_name,
      company: parsed.data.company,
      emails: parsed.data.emails,
      email: parsed.data.email,
      countryCode: parsed.data.country_code,
      cell: parsed.data.cell,
      description: parsed.data.description,
      tags: parsed.data.tags ?? [],
    });
    // Pull each newly-added sender's/domain's recent history into the brain.
    await enqueueBackfills(user.id, addedEmails);
    void recordIngest({
      source: 'contact_create',
      ownerId: user.id,
      nodeId: contact.id,
      summary: `Contact added: ${contact.title.slice(0, 80)}`,
      payload: {
        title: contact.title,
        emails: contact.emails,
        cell_e164: contact.cellE164,
        tags: contact.tags,
        via: 'web_api',
      },
      snippet: contact.description,
    });
    return NextResponse.json({ contact }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'create failed' },
      { status: 400 },
    );
  }
}
