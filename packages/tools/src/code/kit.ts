/**
 * What a code target can use, for code_view with no path: read live from
 * what the target itself enforces, never written out here, so it cannot
 * drift. For an app: the bundler's own allowlist (@mantle/app-build: the
 * bare packages, the UI kit, the vendored libraries and those left out), so
 * a library added there shows here the day it ships.
 */
import {
  APP_CANVAS_LIBRARIES,
  APP_LIBRARIES_LEFT_OUT,
  APP_LIBRARY_SPECIFIERS,
  APP_RUNTIME_LIBRARIES,
  KIT_UI_IMPORTS,
} from '@mantle/app-build';

export type CodeKit = {
  language: string;
  entry: string;
  /** Each import the target allows, with a short note (its guide, when one). */
  imports: { specifier: string; note: string }[];
  /** Known libraries it refuses (the build says why). */
  refused: string[];
  hint: string;
};

/** An app's kit: TSX for the browser, and the imports its build allows. */
export function appKit(entry: string): CodeKit {
  const guides = new Map(
    [...APP_CANVAS_LIBRARIES, ...APP_RUNTIME_LIBRARIES].map((l) => [l.specifier, l.guide]),
  );
  return {
    language: 'TSX (React), bundled by esbuild, runs in the browser',
    entry: `${entry} must export default function App()`,
    imports: [
      { specifier: 'react', note: 'React and its hooks' },
      { specifier: 'react-dom', note: 'React DOM' },
      { specifier: 'lucide-react', note: 'icons' },
      { specifier: '@host', note: '{ host }: host.me(), host.db, host.tools.call' },
      { specifier: '@/lib/utils', note: 'cn()' },
      ...KIT_UI_IMPORTS.map((specifier) => ({ specifier, note: 'UI kit component' })),
      ...APP_LIBRARY_SPECIFIERS.map((specifier) => {
        const guide = guides.get(specifier);
        return {
          specifier,
          note: guide ? `read canvas_library name '${guide}', for 'app' first` : 'library',
        };
      }),
    ],
    refused: Object.keys(APP_LIBRARIES_LEFT_OUT),
    hint: 'Only these imports and relative files build; any other import fails app_build, which names the allowed list.',
  };
}
