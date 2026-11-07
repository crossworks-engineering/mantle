import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('the Bun version', () => {
  it('the image holds the Bun of .bun-version', () => {
    const wanted = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    for (const zip of ['bun-linux-x64-baseline.zip', 'bun-linux-aarch64.zip']) {
      expect(dockerfile).toContain(`/bun-v${wanted}/${zip}`);
    }
  });
});
