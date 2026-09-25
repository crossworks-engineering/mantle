import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import { isAllowlisted, rule } from './system-db-allowlist.mjs';

/**
 * systemDb reads past row level security, so only the listed infrastructure
 * modules may import it (member logins Phase 0b).
 */
describe('system-db-allowlist', () => {
  it('allows the infrastructure modules and tests, refuses the rest', () => {
    expect(isAllowlisted('/repo/packages/tracing/src/store.ts')).toBe(true);
    expect(isAllowlisted('/repo/packages/db/src/client.ts')).toBe(true);
    expect(isAllowlisted('/repo/packages/search/src/index.test.ts')).toBe(true);
    expect(isAllowlisted('/repo/packages/search/src/index.ts')).toBe(false);
    expect(isAllowlisted('/repo/packages/tools/src/builtins-search.ts')).toBe(false);
  });

  const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
  it('flags a systemDb import outside the allowlist, and only that', () => {
    tester.run('system-db-allowlist', rule, {
      valid: [
        { code: "import { db } from '@mantle/db';", filename: '/r/packages/search/src/index.ts' },
        {
          code: "import { db, systemDb } from '@mantle/db';",
          filename: '/r/packages/tracing/src/store.ts',
        },
      ],
      invalid: [
        {
          code: "import { db, systemDb } from '@mantle/db';",
          filename: '/r/packages/search/src/index.ts',
          errors: [{ messageId: 'notAllowed' }],
        },
        {
          code: "import { systemDb as db } from '@mantle/db';",
          filename: '/r/server/web/app/api/x/route.ts',
          errors: [{ messageId: 'notAllowed' }],
        },
      ],
    });
  });
});
