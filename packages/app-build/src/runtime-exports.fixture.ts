/**
 * The shared runtime's export map as a TEST fixture. Production never uses
 * this — `loadRuntimeExports()` reads the generated manifest, so the real
 * check always describes the runtime that is actually deployed. This exists so
 * tests can call `buildApp` without building the whole runtime first.
 *
 * `runtime-exports.drift.test.ts` builds the real runtime and asserts this
 * matches, so a fixture that falls behind fails loudly instead of quietly
 * letting tests pass against a runtime shape that no longer exists.
 */
export const RUNTIME_EXPORTS_FIXTURE: Record<string, string[]> = {
  react: ['default', 'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo'],
  'react-dom': ['default'],
  'react-dom/client': ['createRoot', 'hydrateRoot', 'version'],
  'react/jsx-runtime': ['Fragment', 'jsx', 'jsxs'],
  '@/lib/utils': ['cn'],
  '@/components/ui/button': ['Button'],
  '@/components/ui/card': [
    'Card',
    'CardContent',
    'CardDescription',
    'CardFooter',
    'CardHeader',
    'CardTitle',
  ],
  '@/components/ui/input': ['Input'],
  '@/components/ui/label': ['Label'],
  '@/components/ui/badge': ['Badge'],
  '@/components/ui/separator': ['Separator'],
  '@host': ['__mount', 'host'],
};
