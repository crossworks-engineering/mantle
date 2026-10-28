/**
 * The named gap of the one error gateway (A10 lows item 4;
 * docs/provider-http.md "Behaviour changes"). A catch whose text reaches a
 * member or the model says publicErrorText(err, where) (or, in work that
 * called a provider, publicProviderErrorMessage): a provider's HTTP failure
 * is its fixed sentence, the detail goes to the log and the owner's trace
 * (errorDetail). The catches below still reply `error: errorMessage(err)`:
 * their work calls no model provider directly, and on every surface that
 * masks (every turn, the owner's too; an MCP connection; an app broker;
 * /api/v1) errorMessage collects a provider failure's text and the one
 * masking (publicToolError) answers its sentence instead. The gap is the
 * owner web's own direct tool calls, which do not mask.
 *
 * The pin may only go down: convert a catch (publicErrorText) and lower it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpError, errorMessage } from '@mantle/std';
import { maskToolDatabaseErrors } from './tool-error-mask';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIRS = ['packages/tools/src', 'packages/runtime/src'];

/** Tool replies that still carry errorMessage(err), as of the A10 lows. */
const PIN = 110;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('the error gateway gap (A10 lows item 4)', () => {
  it(`${PIN} tool replies still say errorMessage(err), no more`, () => {
    let n = 0;
    for (const dir of DIRS) {
      for (const file of sources(path.join(ROOT, dir))) {
        n += (readFileSync(file, 'utf8').match(/error: errorMessage\(err\)/g) ?? []).length;
      }
    }
    expect(n).toBeLessThanOrEqual(PIN);
    // Went down: lower the pin in the same change.
    expect(n).toBe(PIN);
  });
});

describe('the one masking answers a caught provider failure (A10 lows item 4)', () => {
  it('a tool that replies errorMessage(err) hands on the sentence, never the body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = new ProviderHttpError({
      provider: 'openai',
      status: 429,
      body: 'org=acme-private',
      what: 'embeddings',
    });
    const out = await maskToolDatabaseErrors('tool note_create', async () => ({
      ok: false,
      error: errorMessage(e),
    }));
    expect(out).toEqual({
      ok: false,
      error: 'The provider limits the request rate. (openai, HTTP 429)',
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
