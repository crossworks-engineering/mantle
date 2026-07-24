import { DocumentationClient } from './documentation-client';

/**
 * Docs landing: read docs from the left sidebar; this pane is the single place to
 * manage indexing — enable/disable a collection for the brain and add new ones.
 * Data-free: DocumentationClient fetches the collections + their formatted sync
 * times + first-doc links from GET /api/docs/collections, and mutates via
 * POST /api/docs/collections, PATCH /api/docs/collections/[id], and
 * POST /api/docs/collections/all.
 */
export default async function DocsLanding() {
  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Documentation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse and read the docs from the list on the left. Below, manage which collections are
          indexed into the brain so the assistant can search them.
        </p>
      </div>
      <DocumentationClient />
    </div>
  );
}
