import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp, type AppSource } from './index';
import { RUNTIME_EXPORTS_FIXTURE as RT } from './runtime-exports.fixture';

/** A minimal valid app: one entry file exporting a default component. */
function app(files: Record<string, string>, entry = 'App.tsx'): AppSource {
  return { entry, files };
}

const TRIVIAL = 'export default function App() {\n  return <div>hi</div>;\n}\n';

describe('buildApp — happy path', () => {
  it('bundles a trivial app into self-mounting ESM', async () => {
    const res = await buildApp(app({ 'App.tsx': TRIVIAL }), { runtimeExports: RT });
    expect(res.ok).toBe(true);
    expect(typeof res.code).toBe('string');
    expect(res.code!.length).toBeGreaterThan(0);
    expect(res.errors).toEqual([]);
    expect(res.esbuildVersion).toMatch(/^\d+\.\d+/);
  });

  it('externalizes React + @host (resolved via the shared runtime import map)', async () => {
    const res = await buildApp(app({ 'App.tsx': TRIVIAL }), { runtimeExports: RT });
    expect(res.ok).toBe(true);
    // React (here the automatic-JSX runtime) and the host bridge are NOT
    // bundled — they remain bare imports the iframe's import map resolves to the
    // one shared runtime. The app ships only its own code, so it stays tiny.
    expect(res.code).toMatch(/["']react\/jsx-runtime["']/);
    expect(res.code).toMatch(/["']@host["']/);
    expect(res.code!.length).toBeLessThan(5000);
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
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('resolves relative imports, including index files', async () => {
    const src = app({
      'App.tsx':
        "import { greet } from './lib/util';\nexport default function App() { return <div>{greet()}</div>; }\n",
      'lib/util.ts': "export { greet } from './greet';\n",
      'lib/greet/index.ts': "export function greet() { return 'hi'; }\n",
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.ok).toBe(true);
  });
});

describe('buildApp — the import allowlist (security boundary)', () => {
  it('rejects an arbitrary npm package with a clear message', async () => {
    const src = app({
      'App.tsx':
        "import _ from 'lodash';\nexport default function App() { return <div>{String(_)}</div>; }\n",
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /not allowed in a mini app|lodash/i.test(e.text))).toBe(true);
  });

  it('rejects node builtins (no server reach from a mini app)', async () => {
    const src = app({
      'App.tsx':
        "import fs from 'node:fs';\nexport default function App() { return <div>{String(fs)}</div>; }\n",
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown @/ alias import', async () => {
    const src = app({
      'App.tsx':
        "import x from '@/components/ui/table';\nexport default function App() { return <div>{String(x)}</div>; }\n",
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /Unknown import/i.test(e.text))).toBe(true);
  });

  it('still bundles lucide-react icons, tree-shaken', async () => {
    const res = await buildApp(
      app({
        'App.tsx':
          "import { Home } from 'lucide-react';\nexport default function App() { return <Home />; }\n",
      }),
      { runtimeExports: RT },
    );
    expect(res.errors).toEqual([]);
    expect(res.code!.length).toBeLessThan(8000);
  });

  it('refuses a computed require() that reaches a readable file on disk', async () => {
    // A file outside the app that parses: on the old code its text landed in
    // the bundle. The path is relative to this package's src, the bundler's
    // resolveDir, as an author would write it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-build-escape-'));
    try {
      fs.writeFileSync(path.join(dir, 'secret.js'), "export default 'SECRET-7f3a';\n");
      const here = path.dirname(fileURLToPath(import.meta.url));
      const rel = path.relative(here, dir).split(path.sep).join('/');
      for (const call of [`require(\`${rel}/\${n}.js\`)`, `import(\`${rel}/\${n}.js\`)`]) {
        const res = await buildApp(
          app({
            'App.tsx': `const n = 'secret';\nconst m = ${call};\nexport default function App() { return <div>{String(m)}</div>; }\n`,
          }),
          { runtimeExports: RT },
        );
        expect(res.ok, call).toBe(false);
        expect(res.code, call).toBeUndefined();
        expect(res.errors[0]!.text, call).toContain('one quoted path');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a computed call in the FIRST layer, whatever the quotes, regexes or comments around it', async () => {
    // The M2's probe (2026-10-24): a string holding a double quote printed in
    // single quotes, and the string-emptying regex swallowed the call. Each
    // case must be refused before the build (the first layer's own text),
    // not by a backstop, and no canary text may come back.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-build-first-layer-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.json'), '{ "CANARY_JSON": 1 }\n');
      fs.writeFileSync(path.join(dir, 'x.js'), "export default 'CANARY_JS';\n");
      const here = path.dirname(fileURLToPath(import.meta.url));
      const R = path.relative(here, dir).split(path.sep).join('/');
      const cases = [
        `const t = ['q"', require(\`${R}/\${n}.json\`), "z"];`,
        `const a = 'he said "hi"'; const m = import(\`${R}/\${n}.js\`); const b = "q";`,
        `const r = /"/; const m = require(\`${R}/\${n}.js\`); const z = "x";`,
        `const r = /['"\`]/g; const m = require(\`${R}/\${n}.js\`); const z = '"';`,
        `/* " */ const m = require(\`${R}/\${n}.js\`); // "`,
        `const m = \`\${require(\`${R}/\${n}.js\`)}\`;`,
        `const m = [1].map(() => require(\`${R}/\${n}.js\`));`,
        `const m = (0, require)(\`${R}/\${n}.js\`);`,
        // Dead code: the bundler still expands it (the audit of 2026-10-24).
        `if (false) { require(\`${R}/\${n}.json\`); }`,
        `const m = false && require(\`${R}/\${n}.json\`);`,
        `function f() { return 1; require(\`${R}/\${n}.json\`); }\nvoid f;`,
        // Syntax a lower transform target refused, so the file went unchecked.
        `import { "a b" as q } from './m';\nconst m = require(\`${R}/\${n}.json\`);\nvoid q;`,
        `await 0;\nconst m = require(\`${R}/\${n}.json\`);`,
        // TypeScript wrappers esbuild strips before it reads the call.
        `const m = (require as any)(\`${R}/\${n}.json\`);`,
        `const m = require!(\`${R}/\${n}.json\`);`,
        `const m = import((\`${R}/\${n}.json\`) as string);`,
        `const m = (require<any>)(\`${R}/\${n}.json\`);`,
        `const m = (require!<any>)(\`${R}/\${n}.json\`);`,
        `const m = require?.(\`${R}/\${n}.json\`);`,
      ];
      for (const line of cases) {
        const res = await buildApp(
          app({
            'App.tsx': `const n = String(Date.now());\n${line}\nexport default function App() { return <div>{String(n)}</div>; }\n`,
            'm.ts': 'const v = 1;\nexport { v as "a b" };\n',
          }),
          { runtimeExports: RT },
        );
        expect(res.ok, line).toBe(false);
        expect(res.code, line).toBeUndefined();
        // The first layer's own text; a backstop's refusal reads differently.
        expect(res.errors[0]!.text, line).toMatch(
          /^(require|import)\(\) in a mini app takes one quoted path/,
        );
        expect(JSON.stringify(res.errors), line).not.toContain('CANARY');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a warning about the app's own code, even when it quotes a path-like key", async () => {
    const res = await buildApp(
      app({
        'App.tsx':
          'const o = { "/api/v1/": 1, "/api/v1/": 2 };\nexport default function App() { return <p>{String(o["/api/v1/"])}</p>; }\n',
      }),
      { runtimeExports: RT },
    );
    expect(res.ok).toBe(true);
    expect(
      res.warnings.some((w) => /Duplicate key/.test(w.text) && w.location?.file === 'app:App.tsx'),
    ).toBe(true);
  });

  it('still builds a typed app: generics, casts, enums and a quoted lazy import', async () => {
    const res = await buildApp(
      app({
        'App.tsx':
          "enum Mode { A, B }\ntype Row<T> = { v: T };\nconst rows: Row<number>[] = [{ v: 1 }];\nconst load = () => import('./B' as string);\nexport default function App() { void load; return <p>{String(rows[0]!.v as number)}{Mode.B}</p>; }\n",
        'B.tsx': 'export default function B() { return <span>b</span>; }\n',
      }),
      { runtimeExports: RT },
    );
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('still builds an app whose strings and regexes only mention require( or import(', async () => {
    const res = await buildApp(
      app({
        'App.tsx':
          "const s = 'say \"require(x)\" or import(`./${y}`) now';\nconst r = /require\\(|import\\(/;\nconst load = () => import('./B');\nexport default function App() { void load; return <p title={String(r)}>{s}</p>; }\n",
        'B.tsx': 'export default function B() { return <span>b</span>; }\n',
      }),
      { runtimeExports: RT },
    );
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('refuses a computed call however it is spelled, and quotes nothing off the app', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-build-escape-'));
    try {
      // A file that fails to parse (its text was quoted in the error) and a
      // folder only NAMED like the allowed package.
      fs.writeFileSync(path.join(dir, 'bad.json'), '{ MARKER_BADJSON: 1 }\n');
      fs.mkdirSync(path.join(dir, 'node_modules', 'lucide-react'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'node_modules', 'lucide-react', 'x.js'),
        "export default 'MARKER_FAKE';\n",
      );
      const here = path.dirname(fileURLToPath(import.meta.url));
      const rel = path.relative(here, dir).split(path.sep).join('/');
      for (const call of [
        `require(\`${rel}/\${n}.json\`)`,
        `requir\\u0065(\`${rel}/\${n}.json\`)`,
        `require(\`${rel}/node_modules/lucide-react/\${n}.js\`)`,
        `require /* c */ (\`${rel}/\${n}.json\`)`,
      ]) {
        const res = await buildApp(
          app({
            'App.tsx': `const n = String(Date.now());\nconst m = ${call};\nexport default function App() { return <div>{String(m)}</div>; }\n`,
          }),
          { runtimeExports: RT },
        );
        expect(res.ok, call).toBe(false);
        expect(res.code, call).toBeUndefined();
        const all = JSON.stringify(res.errors);
        expect(all, call).not.toContain('MARKER');
        expect(all, call).not.toContain(dir);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a computed import() or require() (esbuild read the real disk for it)', async () => {
    for (const call of [
      'require(`./${n}`)',
      'require(`../${n}`)',
      'require(`../../${n}`)',
      'import(`./${n}`)',
      "require('./' + n)",
      "require('../' + n)",
    ]) {
      const res = await buildApp(
        app({
          'App.tsx': `const n = String(Date.now());\nconst m = ${call};\nexport default function App() { return <div>{String(m)}</div>; }\n`,
        }),
        { runtimeExports: RT },
      );
      expect(res.ok, call).toBe(false);
      expect(res.code, call).toBeUndefined();
    }
  });

  it('still builds a quoted import(), and text that only mentions require(', async () => {
    const res = await buildApp(
      app({
        'App.tsx':
          "const load = () => import('./Chart');\nexport default function App() { void load; return <div>{'call require(x) or import(`./${y}`)'}</div>; }\n",
        'Chart.tsx': 'export default function Chart() { return <span>c</span>; }\n',
      }),
      { runtimeExports: RT },
    );
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });
});

describe('buildApp — error reporting', () => {
  it('fails when the entry file is missing from the tree', async () => {
    const res = await buildApp(app({ 'Other.tsx': TRIVIAL }, 'App.tsx'), { runtimeExports: RT });
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.text).toMatch(/not found/i);
  });

  it('reports a file/line location for an unresolvable relative import', async () => {
    const src = app({
      'App.tsx':
        "import { x } from './missing';\nexport default function App() { return <div>{x}</div>; }\n",
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /Cannot resolve/i.test(e.text))).toBe(true);
  });

  it('reports a location for a syntax error', async () => {
    const src = app({
      'App.tsx': 'export default function App() { return <div>oops</div> // missing brace\n',
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.some((e) => e.location !== null)).toBe(true);
  });
});

describe('lintToolRefs — undeclared host.tools.call', () => {
  it('warns (does not error) for a host.tools.call slug that is not declared', async () => {
    const src = app({
      'App.tsx':
        "import { host } from '@host';\n" +
        'export default function App() {\n' +
        "  const go = () => host.tools.call('openweather_geocode', { q: 'x' });\n" +
        '  return <button onClick={go}>go</button>;\n' +
        '}\n',
    });
    const res = await buildApp(src, { declaredToolSlugs: [], runtimeExports: RT });
    expect(res.ok).toBe(true); // warning-only: the build still succeeds
    expect(res.warnings.some((w) => /openweather_geocode/.test(w.text))).toBe(true);
    const w = res.warnings.find((w) => /openweather_geocode/.test(w.text));
    expect(w?.location?.file).toBe('App.tsx');
    expect(w?.location?.line).toBe(3);
  });

  it('does not warn when the slug is declared', async () => {
    const src = app({
      'App.tsx':
        "import { host } from '@host';\n" +
        'export default function App() {\n' +
        "  void (() => host.tools.call('weather_now', {}));\n" +
        '  return <div>ok</div>;\n' +
        '}\n',
    });
    const res = await buildApp(src, { declaredToolSlugs: ['weather_now'], runtimeExports: RT });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => /weather_now/.test(w.text))).toBe(false);
  });

  it('skips the lint entirely when declaredToolSlugs is omitted (back-compat)', async () => {
    const src = app({
      'App.tsx':
        "import { host } from '@host';\n" +
        'export default function App() {\n' +
        "  void (() => host.tools.call('anything', {}));\n" +
        '  return <div>ok</div>;\n' +
        '}\n',
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.warnings.some((w) => /isn't in the app's declared tools/.test(w.text))).toBe(false);
  });

  it('ignores dynamic (non-literal) slugs — no false positives', async () => {
    const src = app({
      'App.tsx':
        "import { host } from '@host';\n" +
        'export default function App() {\n' +
        "  const slug = 'x';\n" +
        '  void (() => host.tools.call(slug, {}));\n' +
        '  return <div>ok</div>;\n' +
        '}\n',
    });
    const res = await buildApp(src, { declaredToolSlugs: [], runtimeExports: RT });
    expect(res.ok).toBe(true);
    expect(res.warnings.length).toBe(0);
  });
});

describe('buildApp: no read of the server disk through an import', () => {
  // Security audit 2026-10-24: the bare allowlist was a prefix match, so
  // `lucide-react/../../package.json` resolved to a file outside the package,
  // and `with { type: 'text' }` made esbuild read any file as text.
  const MARKER = '"private"';
  const tries: Array<[string, string]> = [
    ['parent segments', "import p from 'lucide-react/../../package.json';"],
    ['deep parent segments', "import p from 'react/../../../../package.json';"],
    ['a dot segment', "import p from 'lucide-react/./../../package.json';"],
    ['an empty segment', "import p from 'lucide-react//../../package.json';"],
    ['a backslash', "import p from 'lucide-react\\\\..\\\\..\\\\package.json';"],
    ['a query', "import p from 'lucide-react?raw';"],
    ['a hash', "import p from 'lucide-react#x';"],
    ['text attribute', "import p from 'lucide-react/../../package.json' with { type: 'text' };"],
    ['text attribute on a relative file', "import p from './App.tsx' with { type: 'text' };"],
    ['bytes attribute', "import p from 'lucide-react' with { type: 'bytes' };"],
    ['the bare dot', "import p from '.' with { type: 'json' };"],
    ['the bare double dot', "import p from '..';"],
    ['an absolute path', "import p from '/etc/hosts';"],
  ];
  for (const [name, line] of tries) {
    it(`refuses ${name}`, async () => {
      const src = app({
        'App.tsx': `${line}\nexport default function App() {\n  return <div>{String(p)}</div>;\n}\n`,
      });
      const res = await buildApp(src, { runtimeExports: RT });
      expect(res.ok).toBe(false);
      expect(res.code ?? '').not.toContain(MARKER);
    });
  }

  it('still builds a package file inside an allowed package', async () => {
    const src = app({
      'App.tsx':
        "import pkg from 'lucide-react/package.json';\nexport default function App() {\n  return <div>{pkg.name}</div>;\n}\n",
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('still allows a JSON attribute on a relative JSON file', async () => {
    const src = app({
      'App.tsx':
        "import d from './data.json' with { type: 'json' };\nexport default function App() {\n  return <div>{d.n}</div>;\n}\n",
      'data.json': '{"n": 1}',
    });
    const res = await buildApp(src, { runtimeExports: RT });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });
});
