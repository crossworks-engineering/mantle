/**
 * Client runtime for the /s share surface's interactive presenters — the
 * "islands" the server-rendered HTML mounts by marker div:
 *
 *   <div data-island="<kind>" data-props="<json>"></div>
 *
 * Bundled by scripts/build-share-runtime.ts (esbuild) into
 * public/share-runtime/islands.js and loaded as a module script by the /s
 * template. Client-only mount (no SSR hydration): these three were 'use
 * client' components under Next too, and none of them paints meaningful
 * static content.
 */
import { createRoot } from 'react-dom/client';
import { AppPresenter } from '../../components/share/app-presenter';
import { TablePresenter } from '../../components/share/table-presenter';
import { TeamTokenPrompt } from '../../components/share/team-token-prompt';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ISLANDS: Record<string, (props: any) => React.ReactNode> = {
  app: AppPresenter,
  table: TablePresenter,
  'team-token-prompt': TeamTokenPrompt,
};

for (const el of document.querySelectorAll<HTMLElement>('[data-island]')) {
  const kind = el.dataset.island ?? '';
  const Component = ISLANDS[kind];
  if (!Component) {
    console.error(`[share] unknown island kind: ${kind}`);
    continue;
  }
  let props: Record<string, unknown>;
  try {
    props = JSON.parse(el.dataset.props ?? '{}');
  } catch (err) {
    console.error(`[share] bad island props for ${kind}:`, err);
    continue;
  }
  createRoot(el).render(<Component {...props} />);
}
