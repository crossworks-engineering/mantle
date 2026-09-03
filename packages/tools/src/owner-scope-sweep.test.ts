import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from './builtins';
import { handlerBodyFor, stripNonCode } from './test-support';

/**
 * Every builtin handler must reach the caller's owner id, or be on a short
 * list that says why it does not need one.
 *
 * This exists because counting tests did not work. On 2026-09-03, with
 * handler coverage at 184/242, six tools were still querying owner-scoped
 * data with no owner clause — and three of them (`telegram_react`,
 * `telegram_edit`, `telegram_mark_processed`) sat behind a test file that
 * already drove all three handlers. Those tests asserted the transport call
 * and nothing else, so they passed against unscoped code, which is the same
 * shape as the audit's original finding about ten write-handler tests whose
 * `where` was `vi.fn().mockReturnThis()`.
 *
 * A missing owner clause is invisible in every other way: it does not throw,
 * it does not corrupt anything, the tool reports success. It just answers with
 * — or writes to — somebody else's rows. So the check has to be structural and
 * cover the whole surface, not a per-tool test somebody remembers to write.
 *
 * `emails` is the example of why reading the handler is not enough on its own:
 * it has no owner column, it scopes through `account_id` to
 * `email_accounts.user_id`, so the scope is a JOIN and its absence looks like
 * nothing at all.
 *
 * What this can and cannot do: it proves the owner id is IN HAND in the
 * handler, not that the query uses it correctly. builtins-read-scope.test.ts
 * and builtins-telegram-scope.test.ts walk the real drizzle clause for that.
 * Structure here, behaviour there.
 */

/** Handlers that legitimately never see an owner, each with the reason. */
const OWNER_FREE: Record<string, string> = {
  calculate: 'pure arithmetic on the arguments; touches no store',
  location_distance: 'pure geo maths between two given points',
  web_fetch: 'fetches a public URL through the SSRF guard; no owner state',
  model_catalog:
    'the provider model catalog, identical for everyone on the box; the team-surface refusal is the only ctx it reads',
  run_terminal:
    'a shell on the box itself, which has no per-owner form. Gated by TRANSPORT instead (stdio, or MANTLE_MCP_TERMINAL=1) — see the build-server file header',
};

/** Every non-test source file under this package. */
function sources(dir = new URL('./', import.meta.url)): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...sources(new URL(`${e.name}/`, dir)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(readFileSync(new URL(e.name, dir), 'utf8'));
    }
  }
  return out;
}

const SRC = sources();

/** Passing the whole `ctx` on is as good as passing `ctx.ownerId`: the callee
 *  gets the owner. `web_search` is the live case — a one-line handler that
 *  delegates to `runWebSearch(input, ctx, …)`, which resolves the owner's
 *  OpenRouter key.
 *
 *  Checked against the BODY only. The first version of this test scanned the
 *  whole handler including its own `(input, ctx)` parameter list, which every
 *  handler has, so the sweep passed for all 242 tools while asserting nothing.
 *  Caught by mutation: deleting tree_list's owner clause still passed. */
const FORWARDS_CTX = /\bctx\s*[,)]/;

/** The handler's body: everything after the arrow, so the parameter list
 *  cannot satisfy either check. */
function bodyOf(handlerSrc: string): string {
  const arrow = handlerSrc.indexOf('=>');
  return arrow < 0 ? handlerSrc : handlerSrc.slice(arrow + 2);
}

describe('every builtin handler reaches an owner id', () => {
  it.each(BUILTIN_TOOLS.map((t) => t.slug))('%s', (slug) => {
    const raw = handlerBodyFor(slug, SRC);
    expect(raw, `${slug}: no handler body found in this package`).toBeTruthy();
    const code = stripNonCode(bodyOf(raw!));

    if (slug in OWNER_FREE) return; // asserted separately below
    const hasOwner = /\bownerId\b/.test(code);
    const forwards = FORWARDS_CTX.test(code);
    expect(
      hasOwner || forwards,
      `${slug} never touches ctx.ownerId and never forwards ctx. If it genuinely ` +
        `needs no owner, add it to OWNER_FREE with the reason; otherwise it is ` +
        `querying or writing somebody's data without saying whose.`,
    ).toBe(true);
  });
});

describe('the OWNER_FREE list', () => {
  it('names only real builtins', () => {
    const slugs = new Set(BUILTIN_TOOLS.map((t) => t.slug));
    for (const slug of Object.keys(OWNER_FREE)) {
      expect(slugs.has(slug), `${slug} is not a builtin any more`).toBe(true);
    }
  });

  it('has no stale entries — an exempt tool that gained an owner id must leave', () => {
    // Otherwise the list quietly becomes the place scoping bugs go to hide:
    // once a tool is exempt, nothing ever looks at it again.
    for (const slug of Object.keys(OWNER_FREE)) {
      const code = stripNonCode(bodyOf(handlerBodyFor(slug, SRC) ?? ''));
      expect(
        /\bownerId\b/.test(code),
        `${slug} now uses an owner id — delete its OWNER_FREE entry so it is swept again`,
      ).toBe(false);
    }
  });

  it('stays short, and every entry carries a reason', () => {
    expect(Object.keys(OWNER_FREE).length).toBeLessThanOrEqual(8);
    for (const [slug, why] of Object.entries(OWNER_FREE)) {
      expect(why.length, `${slug} needs a real reason, not a placeholder`).toBeGreaterThan(25);
    }
  });
});
