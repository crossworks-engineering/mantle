import { Download, FileText } from 'lucide-react';
import { formatBytes } from '@mantle/web-ui/lib/format-bytes';

/**
 * Public file render with a media-appropriate viewer: images, PDFs, video, and
 * audio play inline (served from the scoped asset route); everything else gets
 * a clean download card. Centered.
 */
export function FilePresenter({
  view,
  assetUrl,
}: {
  view: { fileId: string; filename: string; mimeType: string; size: number };
  assetUrl: (fileId: string) => string;
}) {
  const src = assetUrl(view.fileId);
  const mime = view.mimeType || '';
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">{view.filename}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {mime || 'file'} · {formatBytes(view.size)}
        </p>
      </header>

      {isImage ? (
        <a href={src} target="_blank" rel="noreferrer" className="block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={view.filename}
            className="mx-auto max-h-[80vh] w-auto rounded-lg border border-border"
          />
        </a>
      ) : isPdf ? (
        <iframe
          src={src}
          title={view.filename}
          className="h-[82vh] w-full rounded-lg border border-border"
        />
      ) : isVideo ? (
        <video
          src={src}
          controls
          className="mx-auto max-h-[80vh] w-full rounded-lg border border-border bg-black"
        />
      ) : isAudio ? (
        <div className="mx-auto max-w-xl rounded-lg border border-border bg-card p-4">
          <audio src={src} controls className="w-full" />
        </div>
      ) : (
        <div className="mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-card p-4">
          <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{view.filename}</p>
            <p className="text-xs text-muted-foreground">{formatBytes(view.size)}</p>
          </div>
          <a
            href={src}
            download={view.filename}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Download className="size-4" aria-hidden /> Download
          </a>
        </div>
      )}
    </div>
  );
}
