import { describe, expect, it } from 'vitest';
import { buildApp, type AppSource } from './index';
import { RUNTIME_EXPORTS_FIXTURE as RT } from './runtime-exports.fixture';

function app(files: Record<string, string>, entry = 'App.tsx'): AppSource {
  return { entry, files };
}

describe('buildApp — per-app CSS', () => {
  it('compiles the utilities the app source uses, mapped to theme tokens', async () => {
    const res = await buildApp(
      app({
        'App.tsx': `export default function App() {
  return (
    <div className="grid grid-cols-7 gap-2 text-[13px]">
      <span className="bg-primary text-primary-foreground">x</span>
    </div>
  );
}
`,
      }),
      { runtimeExports: RT },
    );
    expect(res.ok).toBe(true);
    expect(res.css).toBeTruthy();
    const css = res.css!;
    // A class the repo's own sources never use — the whole point of the
    // per-app compile.
    expect(css).toContain('grid-cols-7');
    expect(css).toContain('text-\\[13px\\]');
    // Colour utilities resolve through the share-ui @theme inline mapping to
    // the runtime tokens, so the host theme styles them.
    expect(css).toContain('var(--primary)');
    // Reference-only theme: no token definitions are emitted (the host sheet
    // owns them).
    expect(css).not.toContain('--color-primary:');
  });

  it('includes the kit component classes (self-sufficient inside the iframe)', async () => {
    const res = await buildApp(
      app({
        'App.tsx': `import { Card } from '@/components/ui/card';
export default function App() { return <Card>x</Card>; }
`,
      }),
      { runtimeExports: RT },
    );
    expect(res.ok).toBe(true);
    // rounded-xl comes from the kit Card source, not the app source.
    expect(res.css).toContain('rounded-xl');
  });

  it('a failed JS build produces no css', async () => {
    const res = await buildApp(app({ 'App.tsx': 'export default function App( {' }), {
      runtimeExports: RT,
    });
    expect(res.ok).toBe(false);
    expect(res.css).toBeUndefined();
  });
});
