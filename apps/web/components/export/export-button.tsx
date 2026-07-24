'use client';

import { Download } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';

/**
 * Download a content node as an Office document. The `/api/export/<id>` route
 * picks the format from the node type (page/note → Word, table → Excel), so
 * this is just a styled download link. `label` is the format word shown beside
 * the icon ("Word" / "Excel").
 */
export function ExportButton({ nodeId, label }: { nodeId: string; label: 'Word' | 'Excel' }) {
  return (
    <Button asChild size="sm" variant="ghost" title={`Download as ${label}`}>
      <a href={`/api/export/${nodeId}`} download>
        <Download />
        <span className="hidden sm:inline">{label}</span>
      </a>
    </Button>
  );
}
