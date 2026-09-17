/**
 * The runtime specifiers are external, so esbuild never checks their shape and
 * a wrong import name survives into a green, publishable build. The browser
 * then rejects the module while LINKING — before any code runs, so nothing the
 * app can install (ErrorBoundary included) ever sees it, and the sandbox can
 * only time out with a generic failure. These tests pin the check that turns
 * that class of bug into a build error.
 */
import { describe, expect, it } from 'vitest';
import { buildApp, lintRuntimeImports } from './index';
import { RUNTIME_EXPORTS_FIXTURE as RT } from './runtime-exports.fixture';

const src = (files: Record<string, string>) => ({ entry: 'App.tsx', files });

describe('lintRuntimeImports', () => {
  it('catches the field bug: a default import of a named-only module', () => {
    const msgs = lintRuntimeImports(src({ 'lib/store.ts': "import host from '@host';\n" }), RT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain("'@host' has no default export");
    // The message has to carry the fix, not just the complaint.
    expect(msgs[0]!.text).toContain("import { __mount } from '@host'");
    expect(msgs[0]!.text).toContain('__mount, host');
    expect(msgs[0]!.location).toEqual({ file: 'lib/store.ts', line: 1, column: 0 });
  });

  it('accepts the correct named import', () => {
    expect(lintRuntimeImports(src({ 'a.ts': "import { host } from '@host';\n" }), RT)).toEqual([]);
  });

  it('catches a named import the module does not export', () => {
    const msgs = lintRuntimeImports(src({ 'a.ts': "import { nope } from '@host';\n" }), RT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain("'@host' does not export 'nope'");
  });

  it('checks the module name, not the local alias', () => {
    expect(lintRuntimeImports(src({ 'a.ts': "import { host as h } from '@host';\n" }), RT)).toEqual(
      [],
    );
    expect(
      lintRuntimeImports(src({ 'a.ts': "import { nope as host } from '@host';\n" }), RT),
    ).toHaveLength(1);
  });

  it('allows a default import where the module really has one', () => {
    expect(lintRuntimeImports(src({ 'a.ts': "import React from 'react';\n" }), RT)).toEqual([]);
  });

  it('reports the right line in a multi-line file', () => {
    const text = "// header\nimport { cn } from '@/lib/utils';\nimport bad from '@host';\n";
    const msgs = lintRuntimeImports(src({ 'a.ts': text }), RT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.location?.line).toBe(3);
  });

  it('ignores relative imports and unknown packages — esbuild rules on those', () => {
    const text = "import x from './local';\nimport y from 'some-npm-pkg';\n";
    expect(lintRuntimeImports(src({ 'a.ts': text }), RT)).toEqual([]);
  });

  it('ignores a namespace import, which binds no names to mismatch', () => {
    expect(lintRuntimeImports(src({ 'a.ts': "import * as h from '@host';\n" }), RT)).toEqual([]);
  });

  it('handles a combined default + named import', () => {
    const msgs = lintRuntimeImports(
      src({ 'a.ts': "import React, { useState } from 'react';\n" }),
      RT,
    );
    expect(msgs).toEqual([]);
  });
});

describe('buildApp — runtime import check', () => {
  it('FAILS the build rather than publishing an app that cannot link', async () => {
    const res = await buildApp(
      src({
        'App.tsx':
          "import { host } from './lib/store';\nexport default function App(){return <div/>;}\n",
        'lib/store.ts': "import host from '@host';\nexport { host };\n",
      }),
      { runtimeExports: RT },
    );
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.text).toContain("'@host' has no default export");
    // Nothing is emitted — a caller must not be able to publish this.
    expect(res.code).toBeUndefined();
  });

  it('builds normally when the imports are right', async () => {
    const res = await buildApp(
      src({
        'App.tsx':
          "import { host } from '@host';\nexport default function App(){return <div>{String(!!host)}</div>;}\n",
      }),
      { runtimeExports: RT },
    );
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });
});
