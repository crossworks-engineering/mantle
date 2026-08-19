import { Download, FileText } from 'lucide-react';
import { formatBytes } from '@mantle/client-types/lib/format-bytes';
import { isEmbedded, type PresenterChrome } from './lib/presenter-chrome';

/**
 * Public file render with a media-appropriate viewer: images, PDFs, video, and
 * audio play inline (served from the scoped asset route); everything else gets
 * a download card.
 *
 * Embedded spans the pane. This is the presenter Jason was describing — a
 * non-previewable file drew a `max-w-md` card, which is a phone-width box
 * marooned in the middle of a 2000px pane. Every branch here gets better with
 * width: a PDF, an image and a video all want the space, and the download row
 * wants to look like a row rather than an island. See `PresenterChrome`.
 */
export function FilePresenter({
  view,
  assetUrl,
  chrome,
}: {
  view: { fileId: string; filename: string; mimeType: string; size: number };
  assetUrl: (fileId: string) => string;
  chrome?: PresenterChrome;
}) {
  const src = assetUrl(view.fileId);
  const mime = view.mimeType || '';
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');
  const embedded = isEmbedded(chrome);

  return (
    <div className={embedded ? 'w-full px-6 py-6' : 'mx-auto max-w-5xl px-6 py-12'}>
      {/* Embedded keeps the type/size line — the pane header carries only the
          filename, so this is the one place a member learns what they are
          looking at — but drops the hero title above it. */}
      <header className={embedded ? 'mb-4' : 'mb-6 text-center'}>
        {!embedded && <h1 className="text-xl font-semibold tracking-tight">{view.filename}</h1>}
        <p
          className={
            embedded ? 'text-xs text-muted-foreground' : 'mt-1 text-xs text-muted-foreground'
          }
        >
          {mime || 'file'} · {formatBytes(view.size)}
        </p>
      </header>

      {isImage ? (
        <a href={src} target="_blank" rel="noreferrer" className="block">
          {/* A plain <img> on purpose: share assets are token-scoped bytes,
              not next/image-optimizable public files. */}
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
          className={
            embedded
              ? 'h-[calc(100dvh-14rem)] min-h-96 w-full rounded-lg border border-border'
              : 'h-[82vh] w-full rounded-lg border border-border'
          }
        />
      ) : isVideo ? (
        <video
          src={src}
          controls
          className="mx-auto max-h-[80vh] w-full rounded-lg border border-border bg-black"
        />
      ) : isAudio ? (
        <div
          className={
            embedded
              ? 'rounded-lg border border-border bg-card p-4'
              : 'mx-auto max-w-xl rounded-lg border border-border bg-card p-4'
          }
        >
          <audio src={src} controls className="w-full" />
        </div>
      ) : (
        <div
          className={
            embedded
              ? 'flex items-center gap-3 rounded-xl border border-border bg-card p-4'
              : 'mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-card p-4'
          }
        >
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
