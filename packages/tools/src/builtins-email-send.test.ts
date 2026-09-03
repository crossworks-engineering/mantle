/**
 * Behavioural tests for email_send and email_page — the two tools that put
 * mail on the wire under the user's real address.
 *
 * These are not "destructive" in the delete sense; they are worse in one
 * respect. A wrong delete can often be recreated. A sent email cannot be
 * unsent, and it goes out as the user, to a third party.
 *
 * The property that matters most is the CONTACTS ALLOWLIST. `contact` nodes
 * are the sole gate on outbound mail (docs/contacts.md), so the check that
 * blocks an unknown recipient is the whole safety model — and it has to cover
 * cc and bcc as well as to, because a blocked recipient smuggled through bcc
 * is exactly as delivered as one in the To line.
 *
 * So the tests below assert the gate holds AND that nothing reached the
 * transport when it fires. Asserting only the error message would pass for a
 * tool that sent the mail and then complained about it.
 *
 * The transport, the account resolver and the allowlist lookup are stubbed;
 * the tools' own ordering and guards are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Mock at the REAL seams, which are lower than they look. `resolveSendAccount`,
 * `blockedRecipients` and `sendEmail` are all INTERNAL to
 * builtins-email.ts — they cannot be module-mocked. So:
 *
 *  - the account list and the allowlist's "own addresses" half both come from
 *    one `db.select().from(emailAccounts).where()` chain, which returns the
 *    same row array to both callers;
 *  - the allowlist's contact half is `contactEmails` from @mantle/content;
 *  - the wire is `sendEmail` from @mantle/email (or sendViaGraph for a
 *    Microsoft account — not exercised here).
 */
const accountRows = [
  {
    id: 'a1',
    userId: 'o1',
    address: 'me@example.com',
    provider: 'imap',
    enabled: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
  },
];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => accountRows),
    then: (res: (v: unknown) => void) => Promise.resolve(accountRows).then(res),
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});
vi.mock('@mantle/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/email')>();
  return { ...actual, sendEmail: vi.fn(), accountCanSend: vi.fn(() => true) };
});
vi.mock('@mantle/microsoft', () => ({
  msAccountCanSend: vi.fn(() => false),
  sendViaGraph: vi.fn(),
}));
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    getPage: vi.fn(),
    contactEmails: vi.fn(async () => [] as string[]),
    findContactsByEmails: vi.fn(async () => []),
    recordContactSent: vi.fn(async () => {}),
    renderPageEmail: vi.fn(async () => ({ html: '<p>x</p>', text: 'x', attachments: [] })),
    createShare: vi.fn(),
  };
});

import { sendEmail, accountCanSend } from '@mantle/email';
import { getPage, contactEmails } from '@mantle/content';
import { EMAIL_TOOLS } from './builtins-email';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const send = EMAIL_TOOLS.find((t) => t.slug === 'email_send')!;
const page = EMAIL_TOOLS.find((t) => t.slug === 'email_page')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

const OK_ARGS = { to: 'friend@example.com', subject: 'Hi', body: 'Hello there' };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears CALLS, not implementations — a `mockReturnValue` set
  // inside one test survives into the next. Re-establish every default here or
  // the suite becomes order-dependent (the "no send-enabled account" case
  // silently poisoned every allowlist case below before this line existed).
  vi.mocked(accountCanSend).mockReturnValue(true);
  // Default: the recipient IS a known contact.
  vi.mocked(contactEmails).mockResolvedValue(['friend@example.com']);
  vi.mocked(sendEmail).mockResolvedValue({
    messageId: 'm1',
    accepted: ['friend@example.com'],
    rejected: [],
  } as never);
});

describe('email_send', () => {
  it('is confirm-gated — it goes out under the user’s real address', () => {
    expect(send.requiresConfirm).toBe(true);
  });

  it.each([
    ['to', { subject: 'Hi', body: 'b' }],
    ['subject', { to: 'a@b.com', body: 'b' }],
    ['body', { to: 'a@b.com', subject: 'Hi' }],
  ])('requires %s, and sends nothing without it', async (_field, args) => {
    const res = await send.handler(args, ctx);
    expect(res.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('fails clearly when no account can send, without reaching the transport', async () => {
    // No enabled account passes canSendFrom → resolveSendAccount returns null.
    vi.mocked(accountCanSend).mockReturnValue(false);
    const res = await send.handler(OK_ARGS, ctx);
    expect(res.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  describe('the contacts allowlist gate', () => {
    it('BLOCKS the send when a recipient is not a contact', async () => {
      // Empty contact list → only the user's own address is allowed. Fail
      // closed is the documented intent: a prompt-injected agent on a fresh
      // install must not be able to email a stranger.
      vi.mocked(contactEmails).mockResolvedValue([]);
      const res = await send.handler({ ...OK_ARGS, to: 'stranger@example.com' }, ctx);

      // Both halves matter. The message alone would pass for a tool that sent
      // the mail and then complained about it.
      expect(errorOf(res)).toMatch(/aren't in the user's contact list/);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('names the blocked recipient and the fix', async () => {
      vi.mocked(contactEmails).mockResolvedValue([]);
      const err = errorOf(await send.handler({ ...OK_ARGS, to: 'stranger@example.com' }, ctx));
      expect(err).toMatch(/stranger@example\.com/);
      // Without /contacts the model cannot tell the user how to unblock it.
      expect(err).toMatch(/\/contacts/);
    });

    it.each(['cc', 'bcc'])('gates %s as strictly as to', async (field) => {
      // A blocked address smuggled through bcc is exactly as delivered as one
      // in the To line. Asserted as an OUTCOME — refused, transport untouched
      // — rather than by inspecting an internal lookup, so it holds however
      // the gate is implemented.
      vi.mocked(contactEmails).mockResolvedValue(['friend@example.com']);
      const res = await send.handler({ ...OK_ARGS, [field]: 'stranger@example.com' }, ctx);
      expect(errorOf(res)).toMatch(/stranger@example\.com/);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('allows the user’s OWN address even with no contacts at all', async () => {
      // The documented carve-out: with an empty contact list an agent can
      // still mail the user, just nobody else.
      vi.mocked(contactEmails).mockResolvedValue([]);
      const res = await send.handler({ ...OK_ARGS, to: 'me@example.com' }, ctx);
      expect(res.ok).toBe(true);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });
  });

  it('sends from the resolved account when every recipient is known', async () => {
    const res = await send.handler(OK_ARGS, ctx);
    expect(res.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [account, msg] = vi.mocked(sendEmail).mock.calls[0]!;
    expect((account as { address: string }).address).toBe('me@example.com');
    expect(msg).toMatchObject({ subject: 'Hi', text: 'Hello there' });
  });
});

describe('email_page', () => {
  beforeEach(() => {
    vi.mocked(getPage).mockResolvedValue({
      id: 'p1',
      title: 'Runbook',
      doc: { type: 'doc', content: [] },
      draft: null,
    } as never);
  });

  it('is confirm-gated, same as email_send', () => {
    expect(page.requiresConfirm).toBe(true);
  });

  it('requires a page and a recipient, and sends nothing without them', async () => {
    expect((await page.handler({ to: 'a@b.com' }, ctx)).ok).toBe(false);
    expect((await page.handler({ pageId: 'p1' }, ctx)).ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('will not email a page that does not exist', async () => {
    vi.mocked(getPage).mockResolvedValue(null as never);
    const res = await page.handler({ pageId: 'p1', to: 'friend@example.com' }, ctx);
    expect(res.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('applies the SAME allowlist gate, and sends nothing when it fires', async () => {
    // email_page is a second door onto the same transport. A gate on one tool
    // and not the other is the same as no gate.
    vi.mocked(contactEmails).mockResolvedValue([]);
    const res = await page.handler({ pageId: 'p1', to: 'stranger@example.com' }, ctx);
    expect(errorOf(res)).toMatch(/aren't in the user's contact list/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('checks the recipient BEFORE it does the work of rendering', async () => {
    vi.mocked(contactEmails).mockResolvedValue([]);
    await page.handler({ pageId: 'p1', to: 'stranger@example.com', includeLink: true }, ctx);
    // includeLink mints a PUBLIC share link. Doing that before the gate would
    // publish the page outward for a send that was then refused.
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
