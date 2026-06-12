'use client';

/**
 * Generic key/value row editor (query params, headers, env vars).
 * Each row: enable checkbox · key · value · remove. Values accept
 * `{{var}}` and `{{secret:service/label}}` templates.
 */

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { emptyKv } from '@/lib/dev-tools/storage';
import type { KeyValueEntry } from '@/lib/dev-tools/types';

export function KvEditor({
  entries,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  addLabel = 'Add row',
}: {
  entries: KeyValueEntry[];
  onChange: (next: KeyValueEntry[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const update = (id: string, patch: Partial<KeyValueEntry>) =>
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  return (
    <div className="space-y-1.5">
      {entries.map((e) => (
        <div key={e.id} className="flex items-center gap-1.5">
          <Checkbox
            checked={e.enabled}
            onCheckedChange={(v) => update(e.id, { enabled: v === true })}
            aria-label="Enabled"
          />
          <Input
            value={e.key}
            onChange={(ev) => update(e.id, { key: ev.target.value })}
            placeholder={keyPlaceholder}
            className="h-8 flex-1 font-mono text-xs"
          />
          <Input
            value={e.value}
            onChange={(ev) => update(e.id, { value: ev.target.value })}
            placeholder={valuePlaceholder}
            className="h-8 flex-[2] font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground"
            onClick={() => onChange(entries.filter((x) => x.id !== e.id))}
            aria-label="Remove row"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground"
        onClick={() => onChange([...entries, emptyKv()])}
      >
        <Plus /> {addLabel}
      </Button>
    </div>
  );
}
