/**
 * The box policy on an agent's tool rows (docs/policy.md): effectiveToolSlugs
 * leaves a switched-off builtin's own slug out, and resolveAgentTools leaves
 * out a row under another name that runs one (`handler: { kind: 'builtin',
 * ref }`), for email sending and Telegram alike. With no policy every row
 * stays.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBoxPolicyForTests } from '@mantle/config';

const rows = vi.hoisted(() => [
  { slug: 'email_send', handler: { kind: 'builtin', ref: 'email_send' } },
  { slug: 'mail_out', handler: { kind: 'builtin', ref: 'email_page' } },
  { slug: 'tg_out', handler: { kind: 'builtin', ref: 'telegram_send' } },
  { slug: 'email_list', handler: { kind: 'builtin', ref: 'email_list' } },
  { slug: 'crm_send', handler: { kind: 'mcp', group: 'crm' } },
]);
vi.mock('@mantle/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tools')>()),
  resolveTools: async (_owner: string, slugs: string[]) =>
    rows.filter((r) => slugs.includes(r.slug)),
}));

const { resolveAgentTools } = await import('./tool-loop');
const all = rows.map((r) => r.slug);

const KEYS = ['MANTLE_POLICY_EMAIL_SEND', 'MANTLE_POLICY_TELEGRAM'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function setPolicy(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
  resetBoxPolicyForTests();
}
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetBoxPolicyForTests();
});

const slugsOf = async () => (await resolveAgentTools('owner-1', all)).map((t) => t.slug);

describe('resolveAgentTools under the box policy', () => {
  it('no policy: every row stays', async () => {
    setPolicy({});
    expect(await slugsOf()).toEqual(all);
  });

  it('email sending off: the send tools and their aliases leave, the rest stay', async () => {
    setPolicy({ MANTLE_POLICY_EMAIL_SEND: 'off' });
    expect(await slugsOf()).toEqual(['tg_out', 'email_list', 'crm_send']);
  });

  it('Telegram off: an alias of a telegram tool leaves too', async () => {
    setPolicy({ MANTLE_POLICY_TELEGRAM: 'off' });
    expect(await slugsOf()).toEqual(['email_send', 'mail_out', 'email_list', 'crm_send']);
  });
});
