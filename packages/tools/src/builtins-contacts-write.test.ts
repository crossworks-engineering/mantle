/**
 * Behavioural tests for contact_create and contact_update: the two tools
 * that EXTEND the email allowlist. Neither had one.
 *
 * A contact is not just an address-book row here: `contact` nodes are the
 * sole gate on outbound mail and on inbound ingest (docs/contacts.md). So a
 * create is "this agent may now email these addresses, and their history
 * gets pulled into the brain". Two things follow that are worth pinning:
 *
 *  - the backfill is enqueued for exactly the addresses the STORE says were
 *    added (`addedEmails`), not for whatever the model typed: an update that
 *    re-sends an existing address must not re-backfill it;
 *  - the backfill never runs when the write did not happen (store threw, or
 *    the id resolved to nothing).
 *
 * The store (`createContact` / `updateContact`) and the backfill queue are
 * stubbed; the tools' own coercion, guards and ordering are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createContact: vi.fn(),
    updateContact: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});
vi.mock('@mantle/email', () => ({ enqueueBackfills: vi.fn(async () => undefined) }));

import { createContact, updateContact } from '@mantle/content';
import { enqueueBackfills } from '@mantle/email';
import { CONTACT_TOOLS } from './builtins-contacts';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ID = '11111111-2222-4333-8444-555555555555';

const create = CONTACT_TOOLS.find((t) => t.slug === 'contact_create')!;
const update = CONTACT_TOOLS.find((t) => t.slug === 'contact_update')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const stored = {
  id: ID,
  title: 'Alex Botha',
  firstName: 'Alex',
  lastName: 'Botha',
  company: '',
  emails: ['alex@example.com'],
  email: 'alex@example.com',
  cellE164: null,
  cellFormatted: null,
  description: 'supplier',
  tags: ['work'],
  contactCounts: {},
  lastContactedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears CALLS, not implementations: re-establish defaults.
  vi.mocked(enqueueBackfills).mockResolvedValue(undefined);
});

describe('contact_create', () => {
  it('writes the cleaned fields under the owner and backfills what the store added', async () => {
    vi.mocked(createContact).mockResolvedValue({
      contact: stored,
      addedEmails: ['alex@example.com', '@example.com'],
    } as never);

    const res = await create.handler(
      {
        first_name: 'Alex',
        last_name: 'Botha',
        // Whitespace and empties are dropped BEFORE the store sees them: a
        // blank entry would otherwise become an allowlist wildcard for nothing.
        emails: [' alex@example.com ', '', '  ', '@example.com', 42],
        description: 'supplier',
        tags: ['work', 7],
      },
      ctx,
    );

    expect(createContact).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({
        firstName: 'Alex',
        lastName: 'Botha',
        emails: ['alex@example.com', '@example.com'],
        description: 'supplier',
        tags: ['work'],
      }),
    );
    // The backfill targets are the STORE's answer, not the model's input.
    expect(enqueueBackfills).toHaveBeenCalledWith('o1', ['alex@example.com', '@example.com']);
    expect(outputOf(res)).toMatchObject({
      id: ID,
      title: 'Alex Botha',
      emails: ['alex@example.com'],
    });
  });

  it('does not enqueue a backfill when the store refused the write', async () => {
    vi.mocked(createContact).mockRejectedValue(new Error('invalid cell number'));

    const res = await create.handler({ first_name: 'Alex', cell: 'abc' }, ctx);

    expect(errorOf(res)).toMatch(/invalid cell number/);
    // No contact ⇒ no allowlist entry ⇒ nothing to pull history for.
    expect(enqueueBackfills).not.toHaveBeenCalled();
  });
});

describe('contact_update', () => {
  it('refuses a blank id WITHOUT touching the store', async () => {
    const res = await update.handler({ id: '   ', first_name: 'Alex' }, ctx);
    expect(errorOf(res)).toMatch(/id/i);
    expect(updateContact).not.toHaveBeenCalled();
    expect(enqueueBackfills).not.toHaveBeenCalled();
  });

  it('reports a miss with the lookup that fixes it, and backfills nothing', async () => {
    vi.mocked(updateContact).mockResolvedValue(null);

    const res = await update.handler({ id: ID, company: 'Modular' }, ctx);

    expect(errorOf(res)).toMatch(/not found/i);
    expect(errorOf(res)).toMatch(/contact_find|contact_list/);
    expect(enqueueBackfills).not.toHaveBeenCalled();
  });

  it('sends only the named fields (omitted ⇒ undefined) and backfills only the additions', async () => {
    vi.mocked(updateContact).mockResolvedValue({
      contact: { ...stored, company: 'Modular' },
      // The store diffed the list: one address was already on file.
      addedEmails: ['orders@modular.example'],
    } as never);

    const res = await update.handler(
      { id: ID, company: 'Modular', emails: ['alex@example.com', 'orders@modular.example'] },
      ctx,
    );

    expect(updateContact).toHaveBeenCalledWith(
      'o1',
      ID,
      expect.objectContaining({
        company: 'Modular',
        emails: ['alex@example.com', 'orders@modular.example'],
        // A patch must leave unmentioned fields alone: undefined, not ''.
        firstName: undefined,
        lastName: undefined,
        description: undefined,
        tags: undefined,
      }),
    );
    expect(enqueueBackfills).toHaveBeenCalledWith('o1', ['orders@modular.example']);
    expect(outputOf(res)).toMatchObject({ id: ID, company: 'Modular' });
  });
});
