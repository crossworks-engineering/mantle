// Flat ESLint config for the whole monorepo. Formatting is Prettier's job
// (see .prettierrc.json / `pnpm format`); ESLint here is purely for *code*
// correctness — dead code, unsafe patterns, real bugs — never style.
//
// Scope is deliberately syntactic (typescript-eslint `recommended`, not the
// type-checked `recommendedTypeChecked`): it needs no per-file type program, so
// `eslint .` stays fast enough for a pre-commit / CI gate. The type-aware rules
// (no-floating-promises, no-misused-promises) and ratcheting the `warn` rules
// below up to `error` are documented follow-ups once the base gate has settled.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import mantlePlugin from './eslint-rules/pair-fill-foreground.mjs';
import mantleDbPlugin from './eslint-rules/system-db-allowlist.mjs';
import mantleHeadsPlugin from './eslint-rules/heads-writers.mjs';
import mantleLevelReadsPlugin from './eslint-rules/level-reads.mjs';
import mantleRawAclPlugin from './eslint-rules/no-raw-acl-columns.mjs';
import mantleAsSystemPlugin from './eslint-rules/as-system-allowlist.mjs';
import mantleStoreBrokersPlugin from './eslint-rules/store-brokers.mjs';
import mantleActorSettersPlugin from './eslint-rules/actor-setters.mjs';
import mantleNoModelInTxPlugin from './eslint-rules/no-model-in-transaction.mjs';
import mantleOwnerCallerPlugin from './eslint-rules/owner-caller-imports.mjs';
import mantleNoGuardCallsPlugin from './eslint-rules/no-guard-calls.mjs';
import mantleEgressPlugin from './eslint-rules/no-bare-fetch.mjs';
import mantleRoutePlumbingPlugin from './eslint-rules/route-plumbing.mjs';
import mantleKindsPlugin from './eslint-rules/no-hand-kind-lists.mjs';
import mantleProviderHttpPlugin from './eslint-rules/provider-http.mjs';

export default tseslint.config(
  {
    // Build output, deps, generated/vendored — never linted.
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'packages/db/migrations/**',
      // Generated Next type shim + generated @host kit bundles (minified,
      // gitignored) — not ours to lint.
      '**/next-env.d.ts',
      'server/web/public/app-runtime/**',
      // Same bundles under the client tree. `.gitignore` has covered this path
      // since the kit landed, but the lint ignore only ever named server/web —
      // so any checkout that had built the client once could not push: the
      // pre-push `pnpm verify` walked 19 minified files and produced ~750
      // errors in code nobody wrote. Untracked here in any case; the client
      // lives in the jackdaw repo and lints itself there.
      'client/web/public/app-runtime/**',
      // Generated share-surface bundle + route manifest (gitignored).
      'server/web/public/share-runtime/**',
      'server/web/server/route-manifest.gen.ts',
      // Local Docker-stack runtime bind-mounts (gitignored; often root-owned
      // mode 700 — must be pruned so `eslint .` doesn't die on EACCES).
      'data/**',
      // Sibling git worktrees live under .claude/ in the integrator clone
      // (gitignored). Each worktree lints itself; never lint them from here.
      '.claude/**',
      // The pre-v0.202 tree (apps/web, apps/api, apps/mcp, apps/agent) was
      // renamed to server/* + client/*. A leftover apps/ is untracked AND
      // ungitignored, so `eslint .` walks it and parses its minified
      // app-runtime bundles as source — 752 errors from a directory that is
      // not part of the repo. That turned the pre-push gate into a wolf-cry
      // (v0.206.3 had to be pushed from a worktree). Deleted 2026-07-27; this
      // stays so a stale checkout can never re-break the gate.
      'apps/**',
      // The docs site (Astro + Starlight) is its own pnpm workspace with its
      // own toolchain; the root config has no parser setup for it.
      'docs-site/**',
      // Agent-tooling trees (.agents/, .codex/, .github/{agents,hooks,skills}).
      // Same wolf-cry as apps/** above: these carry minified vendor bundles that
      // `eslint .` parses as source — 2,428 errors on main, 2026-08-04, entirely
      // from .agents/skills/impeccable + .github/skills/impeccable. Note these
      // are ALREADY gitignored and that is NOT sufficient: flat config does not
      // read .gitignore, so the ignore has to be repeated here.
      '.agents/**',
      '.codex/**',
      '.github/agents/**',
      '.github/hooks/**',
      '.github/skills/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // noUnusedLocals is OFF in tsconfig, so ESLint is the only thing catching
      // dead variables/imports. Allow intentional `_`-prefixed throwaways.
      // Backlog burned down (audit #4) — now `error` so CI blocks new dead code.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `any` is a smell; the few pragmatic untyped-boundary uses carry an
      // inline `eslint-disable` with a reason. Backlog burned down (audit #4) —
      // now `error` so new `any` must be justified explicitly.
      '@typescript-eslint/no-explicit-any': 'error',
      // The `cond ? a() : b()` / `cond && side()` statement idiom is used
      // deliberately for side effects across the UI — allow it while still
      // catching a genuinely dead bare expression.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true },
      ],
    },
  },
  {
    // Plain-JS tooling (no TS to declare Node globals) — teach ESLint about
    // process/console/etc. so no-undef doesn't false-positive.
    files: ['**/*.mjs', '**/*.cjs', '**/*.js', 'scripts/**'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // React/Next linting for the web app. These resolve the inline
    // `eslint-disable react-hooks/*` / `@next/next/*` directives left from the
    // old `next lint` setup, and add real value (hook-deps, next foot-guns).
    // exhaustive-deps backlog triaged + burned down (audit #4) — now `error`;
    // intentional omissions carry an inline `eslint-disable` with a reason.
    //
    // packages/web-ui IS included, and was the gap that proved it matters: the
    // shared components moved there over time while this glob still named only
    // the two apps, so ~30 hook-using components — every provider, the sandbox,
    // the share presenters — were silently unlinted. A missing `tint` dep in
    // the avatar component shipped a picker whose previews never repainted:
    // the state changed, the memo did not.
    files: ['server/web/**/*.{ts,tsx}', 'packages/share-ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@next/next/no-img-element': 'warn',
    },
  },
  {
    // A themed fill must carry an ink that is legible on it. The style guide has
    // said so for months and it still shipped invisible text twice (v0.205.7,
    // v0.206.1) — found by a user, not CI. See eslint-rules/ for why the rule is
    // deliberately narrow: the common `text-muted-foreground hover:bg-accent
    // hover:text-accent-foreground` idiom is CORRECT and must not be flagged.
    files: ['server/web/**/*.{ts,tsx}', 'packages/share-ui/**/*.{ts,tsx}'],
    plugins: { mantle: mantlePlugin },
    rules: { 'mantle/pair-fill-foreground': 'error', 'mantle/use-ink-for-text': 'error' },
  },
  {
    // Environment reads go through @mantle/config (typed names, legacy-alias
    // fallbacks, one inventory — see packages/config/src/index.ts). Bare
    // `process.env` as a whole object (spawning a child with the inherited
    // env) is fine; member reads are not. Excepted: the config package itself,
    // packages/client-types (published to the frontend, where NEXT_PUBLIC_* is
    // a build-time contract), server/sandboxd (standalone image, own config
    // block), the dotenv loader and the boot file that bridges MANTLE_* into
    // the client-types names, plus tests and scripts.
    files: ['server/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: [
      'packages/config/**',
      'packages/client-types/**',
      'server/sandboxd/**',
      'server/web/server/env.ts',
      'server/web/server/main.ts',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/scripts/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env']",
          message:
            'Read environment through @mantle/config (env, envInt, envFlag, envDynamic), not process.env.X.',
        },
      ],
    },
  },
  {
    // systemDb reads past row level security (member logins Phase 0b): only
    // the infrastructure modules allowlisted in the rule file may import it.
    files: ['server/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    plugins: { 'mantle-db': mantleDbPlugin },
    rules: { 'mantle-db/system-db-allowlist': 'error' },
  },
  {
    // Writers of the rows that carry access lock heads first (workspaces
    // plan U1, V5): withHeads and friends from @mantle/db, or a function
    // marked @heads-held (its caller holds them). No exemption marker.
    files: ['server/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    plugins: { 'mantle-heads': mantleHeadsPlugin },
    rules: { 'mantle-heads/heads-writers': 'error' },
  },
  {
    // No product code reads the tier levels (workspaces plan S2, W5b1 on):
    // access comes from grants and currentScope(). What is left is pinned,
    // file by file, in the rule file's allowlist (level-reads.test.ts).
    files: ['server/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs,js}'],
    plugins: { 'mantle-levels': mantleLevelReadsPlugin },
    rules: { 'mantle-levels/level-reads': 'error' },
  },
  {
    // The architecture ratchets (workspaces arch plan v2, section 11; A0):
    // raw ACL column reads outside packages/db, and asSystem call sites,
    // pinned per file in the rule files; arch-lints.test.ts pins them
    // exactly, so a count only goes down. Tests are not product code.
    files: ['server/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs,js}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: {
      'mantle-acl': mantleRawAclPlugin,
      'mantle-system': mantleAsSystemPlugin,
      'mantle-stores': mantleStoreBrokersPlugin,
    },
    rules: {
      'mantle-acl/no-raw-acl-columns': 'error',
      'mantle-system/as-system-allowlist': 'error',
      // Only a store's broker reaches its write API (A3b).
      'mantle-stores/store-brokers': 'error',
    },
  },
  {
    // Only packages/db sets who a statement runs as (workspaces arch A2a):
    // the actor settings and their setter functions, named anywhere else.
    files: ['server/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs,js}'],
    plugins: { 'mantle-actor': mantleActorSettersPlugin },
    rules: { 'mantle-actor/actor-setters-in-db-only': 'error' },
  },
  {
    // No database transaction is held across a model call or a stream
    // (workspaces arch A2b, plan 4.2): it would hold its connection and its
    // heads for the whole call.
    files: ['server/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs,js}'],
    plugins: { 'mantle-tx': mantleNoModelInTxPlugin },
    rules: { 'mantle-tx/no-model-in-transaction': 'error' },
  },
  {
    // The caller the HTTP pipeline answers (ownerCaller(), workspaces arch A4
    // step 3b) is imported only in an app/api route file, by its own name:
    // the manifest generator reads the route files to learn which rows the
    // gate answers.
    // Every script file under server/web, not only .ts and .tsx: a helper
    // in a .mts or .js file would read it unseen too.
    files: ['server/web/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    ignores: ['**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    plugins: { 'mantle-caller': mantleOwnerCallerPlugin },
    rules: { 'mantle-caller/owner-caller-imports': 'error' },
  },
  {
    // No session guard is called outside session.ts (workspaces arch A4
    // exit): a route reads the caller the gate answered for its row. The
    // render pages keep their own redirecting guard (named in the rule).
    files: ['server/web/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    ignores: ['**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    plugins: { 'mantle-guards': mantleNoGuardCallsPlugin },
    rules: { 'mantle-guards/no-guard-calls': 'error' },
  },
  {
    // One egress fetch (A10 part 1, docs/egress.md): product code under
    // packages/ and server/{web,api,mcp,sandboxd}/ uses the platform fetch,
    // or loads a raw HTTP client (undici, node:http(s), axios, got,
    // node-fetch), only in the files the rule file lists (the inventories),
    // each with its kind of host and reason; every other fetch goes through
    // the egress fetch.
    files: [
      'packages/**/*.{ts,tsx,mts,mjs,js}',
      'server/{web,api,mcp,sandboxd}/**/*.{ts,tsx,mts,mjs,js}',
    ],
    ignores: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/scripts/**'],
    plugins: { 'mantle-egress': mantleEgressPlugin },
    rules: { 'mantle-egress/no-bare-fetch': 'error' },
  },
  {
    // Provider HTTP plumbing (A10 #10, docs/provider-http.md): deadlines,
    // retries and Retry-After go through @mantle/std (timeoutSignal and the
    // timeout tables, withRetry, parseRetryAfterMs, withTimeout). The files
    // that keep a pattern are named in the rule file, each with its reason.
    files: [
      'packages/**/*.{ts,tsx,mts,mjs,js}',
      'server/{web,api,mcp,sandboxd}/**/*.{ts,tsx,mts,mjs,js}',
    ],
    ignores: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    plugins: { 'mantle-http': mantleProviderHttpPlugin },
    rules: {
      'mantle-http/inlineTimeout': 'error',
      'mantle-http/handAbortTimer': 'error',
      'mantle-http/withTimeoutCopy': 'error',
      'mantle-http/retryAfterRead': 'error',
      'mantle-http/backoffLoop': 'error',
    },
  },
  {
    // A route reads its body through the one reader (A10 part 2):
    // readBody(req, Schema) or readJson(req), never req.json() and the
    // like. The files that read it another way are named in the rule.
    files: ['server/web/app/**/route.ts'],
    ignores: ['**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    plugins: { 'mantle-plumbing': mantleRoutePlumbingPlugin },
    rules: {
      'mantle-plumbing/no-direct-body-reads': 'error',
      // A route never puts a caught error's text in a reply: it throws and
      // app.onError answers (fold 2). The files not yet moved are named.
      'mantle-plumbing/no-error-text-replies': 'error',
      // A route takes no rate limit and answers no cross-site refusal of its
      // own: both are its ROUTE_POLICY row's (A10 #8, lib/route-limits.ts).
      // The budgets that are not gates on the request are named.
      'mantle-plumbing/no-route-rate-limits': 'error',
    },
  },
  {
    // A list of kinds is a filter over the kind registry (A10 #12,
    // packages/client-types/src/kind-lists.ts), never a literal of 3 or more
    // node types. The files that must keep one are named in the rule.
    files: ['packages/**/*.{ts,tsx,mts,mjs,js}', 'server/**/*.{ts,tsx,mts,mjs,js}'],
    ignores: ['**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    plugins: { 'mantle-kinds': mantleKindsPlugin },
    rules: { 'mantle-kinds/no-hand-kind-lists': 'error' },
  },
  {
    // Tests + one-shot scripts: relax rules that only make sense for shipped code.
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**', '**/scripts/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // share-ui sits one layer up: it may consume the zero-dep contract
    // packages but nothing else @mantle — in particular NOT web-ui, or the
    // published package would drag the whole UI kit into the server image.
    files: ['packages/share-ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@mantle/*',
                '!@mantle/client-types',
                '!@mantle/client-types/*',
                '!@mantle/content-core',
                '!@mantle/content-core/*',
              ],
              message:
                'share-ui may import only @mantle/{client-types,content-core} (jackdaw split boundary)',
            },
          ],
        },
      ],
    },
  },
  {
    // Every PUBLISHED contract package may depend only on its published
    // siblings. Any other @mantle/* import is a private workspace name that
    // does not exist on npm: the v0.232.122-153 app-build tarballs shipped
    // @mantle/std@0.0.1 and @mantle/config@0.0.1 dependencies and could not
    // be installed. scripts/publish-contract.mjs refuses the same at publish
    // time; this catches it at lint time, before the tag.
    files: [
      'packages/client-types/**/*.{ts,tsx}',
      'packages/content-core/**/*.{ts,tsx}',
      'packages/voice-client/**/*.{ts,tsx}',
      'packages/app-build/**/*.{ts,tsx}',
    ],
    // Repo-internal build scripts are not packed (see each package's "files").
    ignores: ['**/scripts/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@mantle/*',
                '!@mantle/client-types',
                '!@mantle/client-types/*',
                '!@mantle/content-core',
                '!@mantle/content-core/*',
                '!@mantle/voice-client',
                '!@mantle/voice-client/*',
                '!@mantle/share-ui',
                '!@mantle/share-ui/*',
                '!@mantle/app-build',
                '!@mantle/app-build/*',
              ],
              message:
                'Contract packages may import only the five published @mantle contract packages; anything else is private and does not exist on npm.',
            },
          ],
        },
      ],
    },
  },
  {
    // Server tier must never import the client app.
    files: ['server/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/client/web/**', '@mantle/client-web*'],
              message: 'server tier must not import the client app',
            },
          ],
        },
      ],
    },
  },
);
