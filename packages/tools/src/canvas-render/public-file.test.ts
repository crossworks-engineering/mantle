/**
 * The renders' public file reader (sidecar.ts publicFile): a file is served
 * only under the asked prefixes, judged on the decoded, normalised path, so
 * an encoded `..` cannot climb from a served prefix into another part of
 * public/ (audit 2026-11-16), and nothing outside public/ is ever read.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./frame-document', () => ({
  canvasFrameDocument: async () => '',
  publicDir: () => `${process.cwd()}/server/web/public`,
}));

import { publicFile } from './sidecar';

describe('publicFile', () => {
  it('serves a file under a served prefix', async () => {
    expect(await publicFile('/Inter/OFL.txt', ['/Inter/'])).not.toBeNull();
  });

  it.each([
    '/Inter/..%2ffavicon.ico',
    '/Inter/..%2Ffavicon.ico',
    '/Inter/%2e%2e/favicon.ico',
    '/Inter/../favicon.ico',
    '/Inter/..%5cfavicon.ico',
  ])('refuses %s: it names a file outside the prefix', async (path) => {
    expect(await publicFile(path, ['/Inter/'])).toBeNull();
  });

  it('never reads outside public/', async () => {
    expect(await publicFile('/Inter/..%2f..%2fpackage.json', ['/Inter/', '/'])).toBeNull();
    expect(await publicFile('/%2e%2e/%2e%2e/package.json', ['/'])).toBeNull();
  });

  it('serves the same file by its own prefix', async () => {
    expect(await publicFile('/favicon.ico', ['/'])).not.toBeNull();
  });
});
