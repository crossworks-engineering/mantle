/* eslint-disable no-empty-pattern -- Playwright's fixture signature is
 * `async ({deps}, use)`; a fixture with no deps destructures nothing, which is
 * the documented idiom (Playwright parses the pattern to build the DI graph). */
import { readFileSync } from 'node:fs';
import {
  test as base,
  request as playwrightRequest,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { PRESENCE_COOKIE, TOKEN_STORAGE_KEY } from './contract';
import { BEARER_PATH, CLIENT_URL, SERVER_URL, STORAGE_STATE_PATH } from './env';

/**
 * Topology-blind fixtures. Specs never branch on topology themselves — they
 * receive an authenticated owner page/API and a clean visitor page, and the
 * project (same-origin vs split) decides how auth actually flows:
 *
 *   same-origin → owner page carries the mantle_session COOKIE; ownerApi
 *                 sends the cookie too.
 *   split       → owner page gets the bearer seeded into localStorage on the
 *                 CLIENT origin (+ presence cookie); ownerApi sends
 *                 Authorization: Bearer against the SERVER origin.
 */
export type Topology = 'same-origin' | 'split';

type Fixtures = {
  topology: Topology;
  serverURL: string;
  clientURL: string;
  /** Authenticated APIRequestContext against the SERVER origin. */
  ownerApi: APIRequestContext;
  /** Authenticated browser page on the CLIENT origin. */
  ownerContext: BrowserContext;
  ownerPage: Page;
  /** Unauthenticated page (anonymous visitor / team member to-be). */
  visitorPage: Page;
};

function bearer(): string {
  return (JSON.parse(readFileSync(BEARER_PATH, 'utf8')) as { token: string }).token;
}

export const test = base.extend<Fixtures>({
  topology: [
    async ({}, use, testInfo) => {
      await use(testInfo.project.name === 'split' ? 'split' : 'same-origin');
    },
    { auto: false },
  ],
  serverURL: async ({}, use) => use(SERVER_URL),
  clientURL: async ({}, use) => use(CLIENT_URL),

  ownerApi: async ({ topology }, use) => {
    const ctx =
      topology === 'split'
        ? await playwrightRequest.newContext({
            baseURL: SERVER_URL,
            extraHTTPHeaders: { Authorization: `Bearer ${bearer()}` },
          })
        : await playwrightRequest.newContext({
            baseURL: SERVER_URL,
            storageState: STORAGE_STATE_PATH,
          });
    await use(ctx);
    await ctx.dispose();
  },

  ownerContext: async ({ browser, topology }, use) => {
    if (topology === 'split') {
      const ctx = await browser.newContext();
      const token = bearer();
      await ctx.addInitScript(
        ([key, value]) => {
          window.localStorage.setItem(key, value);
        },
        [TOKEN_STORAGE_KEY, token] as const,
      );
      const client = new URL(CLIENT_URL);
      await ctx.addCookies([
        {
          name: PRESENCE_COOKIE,
          value: '1',
          domain: client.hostname,
          path: '/',
          secure: client.protocol === 'https:',
          sameSite: 'Lax',
        },
      ]);
      await use(ctx);
      await ctx.close();
    } else {
      const ctx = await browser.newContext({ storageState: STORAGE_STATE_PATH });
      await use(ctx);
      await ctx.close();
    }
  },

  ownerPage: async ({ ownerContext }, use) => {
    const page = await ownerContext.newPage();
    await use(page);
  },

  visitorPage: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
});

export { expect } from '@playwright/test';
