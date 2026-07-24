'use client';

/**
 * Forum attachment UI shared by the reply composer and the new-topic dialog:
 *
 *  - <AttachmentChips> renders a post's attachments (filename + size chip
 *    linking to the member serve route, a subtle "in review" badge while the
 *    owner hasn't triaged the blob, "removed" for dismissed ones).
 *  - <ComposerAttachments> is the paperclip picker + staged-file strip.
 *    Files upload IMMEDIATELY to /api/team/forum/uploads (quarantine — the
 *    brain never sees them until the owner files them); the parent composer
 *    sends the returned blob ids as `attachmentIds` with its post.
 *
 * The /team landing quick box deliberately stays attachment-free (decision:
 * keep it zero-friction).
 */
import { useRef, useState, type ReactNode } from 'react';
import { FileText, Film, Image as ImageIcon, Loader2, Music, Paperclip, X } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { teamFetch, teamUrl } from '@mantle/web-ui/team-fetch';

export type PostAttachment = {
  kind?: string;
  mime?: string;
  caption?: string;
  fileId?: string;
};

export type UploadState = { id: string; status: string; sizeBytes: number };

export type StagedUpload = {
  blobId: string;
  filename: string;
  mime: string;
  size: number;
  kind: string;
};

export const MAX_FILES_PER_POST = 5;
const MAX_UPLOAD_MB = 25;

/** Mirror of @mantle/content formatAttachmentSize — client bundles must not
 *  import server packages, so the 3-line formatter is duplicated knowingly. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function KindIcon({ kind }: { kind?: string }) {
  if (kind === 'image') return <ImageIcon className="size-3.5 shrink-0" aria-hidden />;
  if (kind === 'audio' || kind === 'voice')
    return <Music className="size-3.5 shrink-0" aria-hidden />;
  if (kind === 'video') return <Film className="size-3.5 shrink-0" aria-hidden />;
  return <FileText className="size-3.5 shrink-0" aria-hidden />;
}

const CHIP_CLASS =
  'inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-card-foreground transition-colors hover:bg-accent hover:text-accent-foreground';

/**
 * One downloadable chip. Same-origin it's the plain new-tab anchor it always
 * was (cookie auth, inline preview via content-disposition). On the split
 * client origin a bare link can't carry the member bearer, so the chip
 * fetches the bytes with teamFetch and opens the blob in a new tab —
 * same inline-preview behavior, credential in the header.
 */
function AttachmentChip({ fileId, children }: { fileId: string; children: ReactNode }) {
  const path = `/api/team/forum/attachments/${fileId}`;
  const [busy, setBusy] = useState(false);
  if (teamUrl('') === '') {
    return (
      <a href={path} target="_blank" rel="noreferrer" className={CHIP_CLASS}>
        {children}
      </a>
    );
  }
  const open = async () => {
    if (busy) return;
    setBusy(true);
    // Open the tab SYNCHRONOUSLY (inside the click gesture — a post-await
    // window.open gets popup-blocked), then steer it to the blob when ready.
    const tab = window.open('', '_blank');
    try {
      const r = await teamFetch(path);
      if (!r.ok) {
        tab?.close();
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      if (tab) tab.location = url;
      // Give the new tab time to take the blob before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      tab?.close(); /* network blip — the member can tap again */
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={() => void open()} disabled={busy} className={CHIP_CLASS}>
      {children}
    </button>
  );
}

/** Attachment chips under a post. `states` maps blobId → review state; an
 *  attachment with no state row (race with a sweep) still renders a chip. */
export function AttachmentChips({
  attachments,
  states,
}: {
  attachments: PostAttachment[];
  states: Map<string, UploadState>;
}) {
  const visible = attachments.filter((a) => a.caption || a.fileId);
  if (visible.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visible.map((a, i) => {
        const state = a.fileId ? states.get(a.fileId) : undefined;
        const dismissed = state?.status === 'dismissed';
        const inReview = state?.status === 'pending';
        const label = a.caption || 'attachment';
        const size = state ? ` (${formatSize(state.sizeBytes)})` : '';
        if (dismissed || !a.fileId) {
          return (
            <span
              key={a.fileId ?? `${i}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground line-through"
              title={dismissed ? 'Removed by the brain admin' : undefined}
            >
              <KindIcon kind={a.kind} />
              {label}
            </span>
          );
        }
        return (
          <AttachmentChip key={a.fileId} fileId={a.fileId}>
            <KindIcon kind={a.kind} />
            <span className="max-w-48 truncate">
              {label}
              <span className="text-muted-foreground">{size}</span>
            </span>
            {inReview && (
              <span
                className="rounded-full border border-border px-1.5 py-px text-[10px] uppercase tracking-wider text-muted-foreground"
                title="Not yet in the brain — the admin reviews uploads before they're filed"
              >
                in review
              </span>
            )}
          </AttachmentChip>
        );
      })}
    </div>
  );
}

/**
 * Paperclip picker + staged strip. Controlled: the parent owns `staged`
 * (blob ids go into its post body) and learns about in-flight uploads via
 * `onUploadingChange` so it can hold the send button.
 */
export function ComposerAttachments({
  topicId,
  staged,
  onStagedChange,
  onUploadingChange,
  disabled,
}: {
  /** Known for the reply composer; absent in the new-topic dialog. */
  topicId?: string;
  staged: StagedUpload[];
  onStagedChange: (next: StagedUpload[]) => void;
  onUploadingChange?: (uploading: boolean) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setBusy = (v: boolean) => {
    setUploading(v);
    onUploadingChange?.(v);
  };

  const pick = () => inputRef.current?.click();

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    const picked = [...list];
    // Reset so choosing the same file again re-fires onChange.
    if (inputRef.current) inputRef.current.value = '';

    // Skip individually-bad files and name them, rather than rejecting the whole
    // batch — a member picking one oversized file alongside good ones still gets
    // the good ones staged.
    const skipped: string[] = [];
    let candidates = picked.filter((f) => {
      if (f.size === 0) {
        skipped.push(`'${f.name}' is empty`);
        return false;
      }
      if (f.size > MAX_UPLOAD_MB * 1024 * 1024) {
        skipped.push(`'${f.name}' is over ${MAX_UPLOAD_MB} MB`);
        return false;
      }
      return true;
    });
    const room = MAX_FILES_PER_POST - staged.length;
    if (candidates.length > room) {
      skipped.push(`only ${room} more file${room === 1 ? '' : 's'} allowed per post`);
      candidates = candidates.slice(0, Math.max(0, room));
    }
    if (candidates.length === 0) {
      setError(skipped.length ? `Nothing added — ${skipped.join('; ')}.` : null);
      return;
    }

    const form = new FormData();
    if (topicId) form.set('topicId', topicId);
    for (const f of candidates) form.append('file', f);
    setBusy(true);
    try {
      const r = await teamFetch('/api/team/forum/uploads', { method: 'POST', body: form });
      const data = (await r.json().catch(() => ({}))) as {
        uploads?: StagedUpload[];
        error?: string;
      };
      if (!r.ok || !data.uploads) {
        setError(data.error ?? 'Upload failed — try again.');
        return;
      }
      onStagedChange([...staged, ...data.uploads]);
      setError(
        skipped.length ? `Added ${data.uploads.length}. Skipped: ${skipped.join('; ')}.` : null,
      );
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = (blobId: string) => {
    // Local removal only — the staged blob server-side is reclaimed by the
    // quarantine reconcile pass. The post simply won't reference it.
    onStagedChange(staged.filter((s) => s.blobId !== blobId));
    setError(null); // clear any "at most N files" notice now that there's room
  };

  const atCap = staged.length >= MAX_FILES_PER_POST;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void onFiles(e.target.files)}
        tabIndex={-1}
        aria-hidden
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          onClick={pick}
          disabled={disabled || uploading || atCap}
          aria-label="Attach files"
          title={
            atCap
              ? `Maximum ${MAX_FILES_PER_POST} files per post — remove one to attach another`
              : "Attach files (reviewed by the brain admin before they're filed)"
          }
        >
          {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
        </Button>
        {staged.map((s) => (
          <span
            key={s.blobId}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-card-foreground"
          >
            <KindIcon kind={s.kind} />
            <span className="max-w-48 truncate">
              {s.filename}
              <span className="text-muted-foreground"> ({formatSize(s.size)})</span>
            </span>
            <button
              type="button"
              onClick={() => remove(s.blobId)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`Remove ${s.filename}`}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
