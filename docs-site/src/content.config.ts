import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineCollection } from 'astro:content';
import type { Loader } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
// @ts-expect-error plain JS module shared with astro.config.mjs
import { CHANGELOG_FILE, GUIDE_ROOT, changelogPages, guidePages, mcpToolsPage } from './lib/guide.mjs';

type Page = { id: string; title: string; description?: string; body: string; file?: string };

/**
 * Loads the pages from ../docs/guide and ../CHANGELOG.md at build time. In dev
 * it watches both, so an edit to a doc shows in the browser at once.
 */
const mantleDocs: Loader = {
  name: 'mantle-docs',
  async load({ store, parseData, renderMarkdown, generateDigest, watcher, logger }) {
    const sync = async () => {
      const tools = mcpToolsPage();
      const pages: Page[] = [...guidePages(), ...(tools ? [tools] : []), ...changelogPages()];
      store.clear();
      for (const page of pages) {
        const data = await parseData({
          id: page.id,
          data: { title: page.title, ...(page.description ? { description: page.description } : {}) },
        });
        store.set({
          id: page.id,
          data,
          body: page.body,
          digest: generateDigest(page.body + page.title),
          // The file URL lets Starlight's plugins (asides) claim the page:
          // they only touch files under `markdown.processedDirs`.
          rendered: await renderMarkdown(page.body, page.file ? { fileURL: pathToFileURL(page.file) } : undefined),
        });
      }
      logger.info(`${pages.length} pages from docs/guide and CHANGELOG.md`);
    };
    await sync();
    if (watcher) {
      watcher.add([GUIDE_ROOT, CHANGELOG_FILE]);
      const onChange = (file: string) => {
        if (file.startsWith(GUIDE_ROOT + path.sep) || file === CHANGELOG_FILE) void sync();
      };
      watcher.on('change', onChange);
      watcher.on('add', onChange);
      watcher.on('unlink', onChange);
    }
  },
};

export const collections = {
  docs: defineCollection({ loader: mantleDocs, schema: docsSchema() }),
};
