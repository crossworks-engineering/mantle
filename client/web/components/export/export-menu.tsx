'use client';

import {
  ChevronDown,
  Download,
  FileImage,
  FileText,
  FileType,
  FileType2,
  FileSpreadsheet,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { assetUrl } from '@mantle/web-ui/asset-url';
import { Button } from '@mantle/web-ui/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@mantle/web-ui/ui/dropdown-menu';

type ExportItem = { format: string; label: string; Icon: LucideIcon };

// Pages/notes → Markdown, Word, PDF. Tables → Excel, Markdown table, CSV. Each
// item is a plain download link to `/api/export/<id>?format=…`; the route
// generates bytes on the fly and the resolver picks what the node kind
// supports (PDF via headless Chromium). Hrefs go through assetUrl(): an anchor
// can't carry a bearer, so a detached client targets the server origin with
// the short-lived `?at=` asset token (same-origin passes through unchanged).
const ITEMS: Record<'page' | 'table' | 'draw', ExportItem[]> = {
  page: [
    { format: 'md', label: 'Markdown', Icon: FileText },
    { format: 'docx', label: 'Word', Icon: FileType },
    { format: 'pdf', label: 'PDF', Icon: FileType2 },
  ],
  table: [
    { format: 'xlsx', label: 'Excel', Icon: FileSpreadsheet },
    { format: 'md', label: 'Markdown table', Icon: Table2 },
    { format: 'csv', label: 'CSV', Icon: FileText },
  ],
  // Both serve the COMMITTED snapshot. Exporting the live working scene as
  // PNG/SVG is the canvas's own job (hamburger menu → Export image), which
  // already does it client-side.
  draw: [
    { format: 'svg', label: 'SVG', Icon: FileImage },
    { format: 'pdf', label: 'PDF', Icon: FileType2 },
  ],
};

/**
 * Download a content node in a chosen format. `kind` selects the menu: `page`
 * (Markdown / Word / PDF), `table` (Excel / Markdown table / CSV) or `draw`
 * (SVG / PDF of the committed snapshot). Replaces the single-format
 * ExportButton on a detail header.
 */
export function ExportMenu({
  nodeId,
  kind = 'page',
}: {
  nodeId: string;
  kind?: 'page' | 'table' | 'draw';
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" title="Download">
          <Download />
          <span className="hidden sm:inline">Download</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ITEMS[kind].map(({ format, label, Icon }) => (
          <DropdownMenuItem key={format} asChild>
            <a href={assetUrl(`/api/export/${nodeId}?format=${format}`)} download>
              <Icon />
              {label}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
