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
      'react-hooks/rules-of-hooks': 'warn',
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
    files: [
      'client/web/**/*.{ts,tsx}',
      'server/web/**/*.{ts,tsx}',
      'packages/share-ui/**/*.{ts,tsx}',
    ],
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
