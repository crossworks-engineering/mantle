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
      'client/web/public/app-runtime/**',
      // Local Docker-stack runtime bind-mounts (gitignored; often root-owned
      // mode 700 — must be pruned so `eslint .` doesn't die on EACCES).
      'data/**',
      // Sibling git worktrees live under .claude/ in the integrator clone
      // (gitignored). Each worktree lints itself; never lint them from here.
      '.claude/**',
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
    files: ['server/web/**/*.{ts,tsx}', 'client/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'error',
      '@next/next/no-img-element': 'warn',
    },
  },
  {
    // Tests + one-shot scripts: relax rules that only make sense for shipped code.
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**', '**/scripts/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // ── The split boundary ──────────────────────────────────────────────────
    // client/web + packages/web-ui are the ZERO-SECRET tier: server packages
    // may be imported as TYPES only (erased at compile); values would drag
    // Postgres/node into the browser bundle. The content BARREL is banned as a
    // value even server-side of the fence — clients use its runtime-pure
    // subpaths. `@server/*` and `@/…`-fallback resolution exist for TYPE
    // reach-through only.
    files: ['client/web/**/*.{ts,tsx}', 'packages/web-ui/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            ...[
              '@mantle/db',
              '@mantle/agent-runtime',
              '@mantle/assistant-runtime',
              '@mantle/tools',
              '@mantle/runs',
              '@mantle/email',
              '@mantle/microsoft',
              '@mantle/telegram',
              '@mantle/storage',
              '@mantle/files',
              '@mantle/search',
              '@mantle/embeddings',
              '@mantle/rules',
              '@mantle/heartbeats',
              '@mantle/calendar',
              '@mantle/crypto',
              '@mantle/api-keys',
              '@mantle/mcp-core',
              '@mantle/tracing',
              '@mantle/tabledb',
              '@mantle/turn-stream',
            ].map((name) => ({
              name,
              allowTypeImports: true,
              message: 'server-only package — the client tier may import types only',
            })),
            {
              name: '@mantle/content',
              allowTypeImports: true,
              message:
                'import a runtime-pure subpath (e.g. @mantle/content/markdown), never the barrel',
            },
          ],
          patterns: [
            {
              group: ['@server/*'],
              allowTypeImports: true,
              message:
                '@server/* is a TYPE-only reach-through into server/web — values would bundle server code',
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
