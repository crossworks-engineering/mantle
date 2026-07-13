'use client';

import { ChevronDown, Download, FileText, FileType, FileType2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

/**
 * Download a Page as Markdown, Word, or PDF. Each item is a plain download link
 * to `/api/export/<id>?format=…`; the route generates the bytes on the fly
 * (Markdown/Word via resolveExport, PDF via headless Chromium). Replaces the
 * single-format ExportButton on the page detail header.
 */
export function ExportMenu({ nodeId }: { nodeId: string }) {
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
        <DropdownMenuItem asChild>
          <a href={`/api/export/${nodeId}?format=md`} download>
            <FileText />
            Markdown
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`/api/export/${nodeId}?format=docx`} download>
            <FileType />
            Word
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`/api/export/${nodeId}?format=pdf`} download>
            <FileType2 />
            PDF
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
