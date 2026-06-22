import { describe, expect, it } from 'vitest';
import { buildApp, type AppSource } from './index';

/** A minimal valid app: one entry file exporting a default component. */
function app(files: Record<string, string>, entry = 'App.tsx'): AppSource {
  return { entry, files };
}

const TRIVIAL = 'export default function App() {\n  return <div>hi</div>;\n}\n';

describe('buildApp — happy path', () => {
  it('bundles a trivial app into self-mounting ESM', async () => {
    const res = await buildApp(app({ 'App.tsx': TRIVIAL }));
    expect(res.ok).toBe(true);
    expect(typeof res.code).toBe('string');
    expect(res.code!.length).toBeGreaterThan(0);
    expect(res.errors).toEqual([]);
    expect(res.esbuildVersion).toMatch(/^\d+\.\d+/);
  });

  it('inlines React (no bare external imports remain)', async () => {
    const res = await buildApp(app({ 'App.tsx': TRIVIAL }));
    expect(res.ok).toBe(true);
    // The bundle must be standalone — React is bundled, not left as an import.
    expect(res.code).not.toMatch(/from\s*["']react["']/);
    expect(res.code).not.toMatch(/import\s*\{[^}]*\}\s*from\s*["']react-dom/);
  });

  it('allows the curated runtime: react, lucide-react, the kit, and @host', async () => {
    const src = app({
      'App.tsx':
        "import { useState } from 'react';\n" +
        "import { Home } from 'lucide-react';\n" +
        "import { Button } from '@/components/ui/button';\n" +
        "import { cn } from '@/lib/utils';\n" +
        "import { host } from '@host';\n" +
        'export default function App() {\n' +
        '  const [n] = useState(0);\n' +
        '  void host; void cn; void Home;\n' +
        '  return <Button>{n}</Button>;\n' +
        '}\n',
    });
    const res = await buildApp(src);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('resolves relative imports, including index files', async () => {
    const src = app({
      'App.tsx': "import { greet } from './lib/util';\nexport default function App() { return <div>{greet()}</div>; }\n",
      'lib/util.ts': "export { greet } from './greet';\n",
      'lib/greet/index.ts': "export function greet() { return 'hi'; }\n",
    });
    const res = await buildApp(src);
    expect(res.ok).toBe(true);
  });
});

describe('buildApp — the import allowlist (security boundary)', () => {
  it('rejects an arbitrary npm package with a clear message', async () => {
    const src = app({ 'App.tsx': "import _ from 'lodash';\nexport default function App() { return <div>{String(_)}</div>; }\n" });
    const res = await buildApp(src);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /not allowed in a mini app|lodash/i.test(e.text))).toBe(true);
  });

  it('rejects node builtins (no server reach from a mini app)', async () => {
    const src = app({ 'App.tsx': "import fs from 'node:fs';\nexport default function App() { return <div>{String(fs)}</div>; }\n" });
    const res = await buildApp(src);
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown @/ alias import', async () => {
    const src = app({ 'App.tsx': "import x from '@/components/ui/table';\nexport default function App() { return <div>{String(x)}</div>; }\n" });
    const res = await buildApp(src);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /Unknown import/i.test(e.text))).toBe(true);
  });
});

describe('buildApp — error reporting', () => {
  it('fails when the entry file is missing from the tree', async () => {
    const res = await buildApp(app({ 'Other.tsx': TRIVIAL }, 'App.tsx'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.text).toMatch(/not found/i);
  });

  it('reports a file/line location for an unresolvable relative import', async () => {
    const src = app({ 'App.tsx': "import { x } from './missing';\nexport default function App() { return <div>{x}</div>; }\n" });
    const res = await buildApp(src);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /Cannot resolve/i.test(e.text))).toBe(true);
  });

  it('reports a location for a syntax error', async () => {
    const src = app({ 'App.tsx': 'export default function App() { return <div>oops</div> // missing brace\n' });
    const res = await buildApp(src);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.some((e) => e.location !== null)).toBe(true);
  });
});
