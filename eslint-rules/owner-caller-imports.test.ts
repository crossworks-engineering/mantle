import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import { isApiRouteFile, isExempt, rule } from './owner-caller-imports.mjs';

/**
 * ownerCaller is imported by its own name, only in an app/api route file
 * (A4 step 3b): the manifest generator reads the route files to learn which
 * rows the gate answers, so a read elsewhere would run unanswered.
 */
describe('owner-caller-imports', () => {
  it('knows the route files and the exempt ones', () => {
    expect(isApiRouteFile('/r/server/web/app/api/profile/route.ts')).toBe(true);
    expect(isApiRouteFile('/r/server/web/app/api/help/[topic]/route.ts')).toBe(true);
    expect(isApiRouteFile('/r/server/web/app/api/profile/helpers.ts')).toBe(false);
    expect(isApiRouteFile('/r/server/web/lib/who.ts')).toBe(false);
    expect(isExempt('/r/server/web/lib/auth/session.ts')).toBe(true);
    expect(isExempt('/r/server/web/server/middleware/gate-caller.test.ts')).toBe(true);
    expect(isExempt('/r/server/web/lib/auth.ts')).toBe(false);
  });

  const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
  const route = '/r/server/web/app/api/profile/route.ts';
  const lib = '/r/server/web/lib/who.ts';

  it('allows the plain import in a route file, and refuses the rest', () => {
    tester.run('owner-caller-imports', rule, {
      valid: [
        { code: "import { ownerCaller } from '@/lib/auth';\nownerCaller();", filename: route },
        { code: "import { ownerCaller } from '@/lib/auth/session';", filename: route },
        { code: "import { getOwnerOr401 as g } from '@/lib/auth';", filename: lib },
        { code: "export * from './auth/session';", filename: '/r/server/web/lib/auth.ts' },
        {
          code: "import * as s from './session';\ns.ownerCaller();",
          filename: '/r/server/web/x.test.ts',
        },
      ],
      invalid: [
        // A helper of lib (the audit's libHelper).
        {
          code: "import { ownerCaller } from '@/lib/auth';\nexport const whoAmI = () => ownerCaller();",
          filename: lib,
          errors: [{ messageId: 'notRoute' }],
        },
        // A non-route file beside the route.
        {
          code: "import { ownerCaller } from '@/lib/auth';",
          filename: '/r/server/web/app/api/profile/helpers.ts',
          errors: [{ messageId: 'notRoute' }],
        },
        // Renamed (the audit's aliasImport).
        {
          code: "import { ownerCaller as oc } from '@/lib/auth';",
          filename: route,
          errors: [{ messageId: 'renamed' }],
        },
        {
          code: "import { ownerCaller } from '@/lib/who';",
          filename: route,
          errors: [{ messageId: 'module' }],
        },
        {
          code: "export { ownerCaller } from '@/lib/auth/session';",
          filename: '/r/server/web/lib/who.ts',
          errors: [{ messageId: 'reexport' }],
        },
        // Read off an object (namespaceImport, elementAccess).
        {
          code: "import * as auth from '@/lib/auth';\nauth.ownerCaller();",
          filename: lib,
          errors: [{ messageId: 'member' }],
        },
        {
          code: "import * as auth from '@/lib/auth';\nauth['ownerCaller']();",
          filename: route,
          errors: [{ messageId: 'member' }],
        },
        // Destructured from a dynamic import (dynImport).
        {
          code: "const { ownerCaller } = await import('@/lib/auth');",
          filename: lib,
          errors: [{ messageId: 'member' }],
        },
      ],
    });
  });
});
