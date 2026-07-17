'use client';

import { useState, useTransition } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';
import { slugify } from '@/lib/slugify';
import { useToast } from '@/components/ui/toast';
import { apiSend } from '@/lib/api-fetch';

/** Lowercase-slug a label for the default key (mirrors the action's regex). */
/**
 * "New collection" form (Dialog) for the /docs index. Registers a new
 * doc collection pointing at a folder of markdown on disk; on success it's
 * created enabled and reconciled, so its docs appear at /docs immediately.
 */
export function NewCollectionDialog() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [rootPath, setRootPath] = useState('');
  const [brainDepth, setBrainDepth] = useState<'retrieval' | 'full'>('retrieval');

  function reset() {
    setLabel('');
    setKey('');
    setKeyEdited(false);
    setRootPath('');
    setBrainDepth('retrieval');
  }

  function onLabelChange(v: string) {
    setLabel(v);
    if (!keyEdited) setKey(slugify(v));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const res = await apiSend<{ ok: boolean; message: string }>(
          '/api/docs/collections',
          'POST',
          { label, key, rootPath, brainDepth },
        );
        if (res.ok) {
          toast.success(res.message);
          setOpen(false);
          reset();
          queryClient.invalidateQueries({ queryKey: ['docs', 'collections'] });
        } else {
          toast.error(res.message);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not create collection');
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New collection
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New documentation collection</DialogTitle>
          <DialogDescription>
            Index a folder of markdown files into the brain. It&apos;s created enabled and synced
            right away, then appears at <span className="font-medium">/docs</span>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="nc-label">Label</Label>
            <Input
              id="nc-label"
              value={label}
              onChange={(e) => onLabelChange(e.target.value)}
              placeholder="User Guide"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="nc-key">Key</Label>
            <Input
              id="nc-key"
              value={key}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value);
              }}
              placeholder="guide"
            />
            <p className="text-xs text-muted-foreground">
              Lowercase slug, unique per install. Used as the stable id.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="nc-root">Root path</Label>
            <Input
              id="nc-root"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="guide"
            />
            <p className="text-xs text-muted-foreground">
              Relative paths (e.g. <span className="font-mono">guide</span>) resolve under the docs
              root and travel across machines — best for repo-shipped docs. Use an absolute path for
              an external folder. Note: “System docs” already covers all of{' '}
              <span className="font-mono">docs/</span>, so don&apos;t enable it alongside a child
              collection.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="nc-depth">Brain depth</Label>
            <Select
              value={brainDepth}
              onValueChange={(v) => setBrainDepth(v as 'retrieval' | 'full')}
            >
              <SelectTrigger id="nc-depth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="retrieval">Retrieval-only (find &amp; cite)</SelectItem>
                <SelectItem value="full">Full extraction (facts &amp; entities too)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Retrieval-only keeps these docs out of your personal facts/graph — the right default
              for reference material.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <SubmitButton pending={pending}>Create collection</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
