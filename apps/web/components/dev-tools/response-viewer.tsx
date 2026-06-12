'use client';

/**
 * Response viewer — right panel of the API Console. Status pill, timing,
 * size, then Body (JSON tree) / Raw / Headers tabs. Tool + MCP results
 * reuse the same surface; artifacts (audio/image metadata) get a strip.
 */

import { Loader2 } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDevTools } from './context';
import { JsonTree } from './json-tree';
import { StatusPill, formatBytes } from './status-pill';

export function ResponseViewer() {
  const { response, sending } = useDevTools();

  if (sending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Waiting for response…
      </div>
    );
  }

  if (!response) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Pick a call from the library and hit Send — the response lands here.
      </div>
    );
  }

  const viaLabel =
    response.via === 'proxy'
      ? 'via server proxy'
      : response.via === 'tool'
        ? 'via tool dispatcher'
        : response.via === 'mcp'
          ? 'via MCP server'
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <StatusPill status={response.status} statusText={response.statusText} />
        <span className="font-mono text-xs text-muted-foreground">{response.durationMs}ms</span>
        <span className="font-mono text-xs text-muted-foreground">
          {formatBytes(response.sizeBytes)}
          {response.truncated && ' (truncated)'}
        </span>
        {viaLabel && <span className="text-[10px] text-muted-foreground/70">{viaLabel}</span>}
        <span className="flex-1" />
        {response.bodyText && <CopyButton value={response.bodyText} />}
      </div>

      {response.networkError ? (
        <div className="p-3">
          <p className="rounded-md bg-destructive/10 p-3 font-mono text-xs text-destructive">
            {response.networkError}
          </p>
        </div>
      ) : (
        <Tabs defaultValue="body" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-3 mt-2 h-8 self-start">
            <TabsTrigger value="body" className="text-xs">
              Body
            </TabsTrigger>
            <TabsTrigger value="raw" className="text-xs">
              Raw
            </TabsTrigger>
            <TabsTrigger value="headers" className="text-xs">
              Headers ({response.headers.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="body" className="min-h-0 flex-1 overflow-auto p-3 scrollbar-thin">
            {response.artifacts && response.artifacts.length > 0 && (
              <div className="mb-2 space-y-1">
                {response.artifacts.map((a, i) => (
                  <p key={i} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                    produced {a.kind} ({a.mimeType}){a.caption ? ` — ${a.caption}` : ''}
                  </p>
                ))}
              </div>
            )}
            {response.json !== null ? (
              <JsonTree value={response.json} />
            ) : response.bodyText ? (
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">
                {response.bodyText}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">Empty body.</p>
            )}
          </TabsContent>

          <TabsContent value="raw" className="min-h-0 flex-1 overflow-auto p-3 scrollbar-thin">
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">
              {response.bodyText || '(empty)'}
            </pre>
          </TabsContent>

          <TabsContent value="headers" className="min-h-0 flex-1 overflow-auto p-3 scrollbar-thin">
            {response.headers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {response.via === 'tool' || response.via === 'mcp'
                  ? 'Tool calls have no HTTP headers.'
                  : 'No headers captured.'}
              </p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {response.headers.map(([k, v], i) => (
                    <tr key={`${k}_${i}`} className="align-top">
                      <td className="whitespace-nowrap py-0.5 pr-3 font-mono text-muted-foreground">
                        {k}
                      </td>
                      <td className="break-all py-0.5 font-mono">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
