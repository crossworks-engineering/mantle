import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import { isExempt, mayName, rule } from './no-guard-calls.mjs';

/**
 * no-guard-calls (A4 exit): no session guard outside session.ts, which
 * runs them for the gate; a route reads the caller the gate answered. The
 * render pages keep their own redirecting guard, by name.
 */
describe('no-guard-calls', () => {
  it('knows the exempt files and the one exception', () => {
    expect(isExempt('/r/server/web/lib/auth/session.ts')).toBe(true);
    expect(isExempt('/r/server/web/server/middleware/gate-caller.test.ts')).toBe(true);
    expect(isExempt('/r/server/web/lib/auth.ts')).toBe(false);
    expect(isExempt('/r/server/web/lib/gone.ts')).toBe(false);
    expect(mayName('/r/server/web/server/pages/print.ts', 'requireOwnerForRender')).toBe(true);
    expect(mayName('/r/server/web/server/pages/print.ts', 'getSessionUser')).toBe(false);
    expect(mayName('/r/server/web/lib/x.ts', 'requireOwnerForRender')).toBe(false);
  });

  const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
  const route = '/r/server/web/app/api/profile/route.ts';
  const lib = '/r/server/web/lib/who.ts';

  it('allows the readers, the definition, tests and the render pages; refuses a guard', () => {
    tester.run('no-guard-calls', rule, {
      valid: [
        { code: "import { ownerCaller } from '@/lib/auth';\nownerCaller();", filename: route },
        {
          code: "import { publicLoginItself } from '@/lib/auth';\nawait publicLoginItself();",
          filename: route,
        },
        { code: "export * from './auth/session';", filename: '/r/server/web/lib/auth.ts' },
        {
          code: 'export async function getLoginOr401() {}\ngetLoginOr401();',
          filename: '/r/server/web/lib/auth/session.ts',
        },
        {
          code: "import { getLoginOr401 } from '@/lib/auth';",
          filename: '/r/server/web/server/x.test.ts',
        },
        {
          code: "import { requireOwnerForRender } from '@/lib/auth';",
          filename: '/r/server/web/server/pages/print.ts',
        },
      ],
      invalid: [
        {
          code: "import { getLoginOr401 } from '@/lib/auth';\nawait getLoginOr401();",
          filename: route,
          errors: [{ messageId: 'guard' }],
        },
        {
          code: "import { getOwnerForAsset as g } from '@/lib/auth';",
          filename: lib,
          errors: [{ messageId: 'guard' }],
        },
        {
          code: "import * as auth from '@/lib/auth';\nauth.getCookieUpgradeLoginOr401();",
          filename: lib,
          errors: [{ messageId: 'guard' }],
        },
        {
          code: "import * as auth from '@/lib/auth';\nauth['getMemberOr401']();",
          filename: route,
          errors: [{ messageId: 'guard' }],
        },
        {
          code: "const { getChatLoginOr401 } = await import('@/lib/auth');",
          filename: route,
          errors: [{ messageId: 'guard' }],
        },
        {
          code: "export { getSessionUser } from '@/lib/auth';",
          filename: lib,
          errors: [{ messageId: 'guard' }],
        },
        {
          code: "import { getSessionUser } from '@/lib/auth';",
          filename: '/r/server/web/server/pages/print.ts',
          errors: [{ messageId: 'guard' }],
        },
      ],
    });
  });
});
