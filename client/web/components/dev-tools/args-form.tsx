'use client';

/**
 * Schema-driven arguments form for tool/MCP drafts — the human-friendly
 * projection of the JSON args editor. The console's promise is "the exact
 * call an agent would make"; this makes composing that call as safe as the
 * schema allows: required markers, enums as selects, descriptions as help
 * text, numbers that stay numbers.
 *
 * The JSON text stays the single source of truth — the form reads it, edits
 * patch it, and keys the form doesn't understand (nested objects the schema
 * declares, extra keys the user typed in the JSON tab) are preserved
 * untouched. If the JSON doesn't parse, the form says so and defers to the
 * JSON tab rather than guessing.
 */

import { useMemo } from 'react';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { Textarea } from '@mantle/web-ui/ui/textarea';

type PropDef = {
  key: string;
  required: boolean;
  description: string | null;
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'json';
  enumValues: unknown[] | null;
};

const UNSET = '__unset__';

function classify(def: Record<string, unknown>): PropDef['kind'] {
  if (Array.isArray(def.enum) && def.enum.length > 0) return 'enum';
  const t = Array.isArray(def.type) ? def.type[0] : def.type;
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'json';
}

export function schemaProps(schema: Record<string, unknown> | null | undefined): PropDef[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = schema.properties;
  if (!props || typeof props !== 'object') return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: PropDef[] = [];
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const def = raw as Record<string, unknown>;
    out.push({
      key,
      required: required.has(key),
      description: typeof def.description === 'string' ? def.description : null,
      kind: classify(def),
      enumValues: Array.isArray(def.enum) && def.enum.length > 0 ? def.enum : null,
    });
  }
  // Required first, otherwise schema order (which authors chose deliberately).
  return [...out.filter((p) => p.required), ...out.filter((p) => !p.required)];
}

export function ArgsForm({
  schema,
  argsText,
  onArgsText,
}: {
  schema: Record<string, unknown> | null | undefined;
  argsText: string;
  onArgsText: (next: string) => void;
}) {
  const props = useMemo(() => schemaProps(schema), [schema]);

  const parsed = useMemo(() => {
    try {
      const v = JSON.parse(argsText.trim() === '' ? '{}' : argsText) as unknown;
      return v !== null && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }, [argsText]);

  if (props.length === 0) return null;
  if (parsed === null) {
    return (
      <p className="rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
        The JSON tab holds args this form can't represent (invalid or non-object JSON) — fix it
        there and the form comes back.
      </p>
    );
  }

  const setKey = (key: string, value: unknown | undefined) => {
    const next = { ...parsed };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onArgsText(JSON.stringify(next, null, 2));
  };

  const known = new Set(props.map((p) => p.key));
  const extraKeys = Object.keys(parsed).filter((k) => !known.has(k));

  return (
    <div className="space-y-2.5">
      {props.map((p) => {
        const current = parsed[p.key];
        const help = p.description ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{p.description}</p>
        ) : null;
        const label = (
          <Label htmlFor={`arg-${p.key}`} className="font-mono text-xs">
            {p.key}
            {p.required && <span className="ml-0.5 text-destructive">*</span>}
          </Label>
        );

        if (p.kind === 'enum' && p.enumValues) {
          const asStr = current === undefined ? UNSET : JSON.stringify(current);
          return (
            <div key={p.key} className="space-y-1">
              {label}
              <Select
                value={asStr}
                onValueChange={(v) =>
                  setKey(p.key, v === UNSET ? undefined : (JSON.parse(v) as unknown))
                }
              >
                <SelectTrigger id={`arg-${p.key}`} className="h-8 text-xs">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {!p.required && (
                    <SelectItem value={UNSET} className="text-xs text-muted-foreground">
                      (not set)
                    </SelectItem>
                  )}
                  {p.enumValues.map((v) => (
                    <SelectItem
                      key={JSON.stringify(v)}
                      value={JSON.stringify(v)}
                      className="text-xs"
                    >
                      {String(v)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {help}
            </div>
          );
        }

        if (p.kind === 'boolean') {
          const asStr = current === undefined ? UNSET : String(current);
          return (
            <div key={p.key} className="space-y-1">
              {label}
              <Select
                value={asStr}
                onValueChange={(v) => setKey(p.key, v === UNSET ? undefined : v === 'true')}
              >
                <SelectTrigger id={`arg-${p.key}`} className="h-8 text-xs">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {!p.required && (
                    <SelectItem value={UNSET} className="text-xs text-muted-foreground">
                      (not set)
                    </SelectItem>
                  )}
                  <SelectItem value="true" className="text-xs">
                    true
                  </SelectItem>
                  <SelectItem value="false" className="text-xs">
                    false
                  </SelectItem>
                </SelectContent>
              </Select>
              {help}
            </div>
          );
        }

        if (p.kind === 'number') {
          return (
            <div key={p.key} className="space-y-1">
              {label}
              <Input
                id={`arg-${p.key}`}
                inputMode="decimal"
                value={current === undefined ? '' : String(current)}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (raw === '') return setKey(p.key, undefined);
                  const n = Number(raw);
                  // Mid-typing states ("1e", "-") stay as strings until they
                  // parse; the JSON tab always shows the truth.
                  setKey(p.key, Number.isFinite(n) ? n : raw);
                }}
                className="h-8 font-mono text-xs"
              />
              {help}
            </div>
          );
        }

        if (p.kind === 'string') {
          return (
            <div key={p.key} className="space-y-1">
              {label}
              <Input
                id={`arg-${p.key}`}
                value={
                  typeof current === 'string'
                    ? current
                    : current === undefined
                      ? ''
                      : String(current)
                }
                onChange={(e) =>
                  setKey(p.key, e.target.value === '' && !p.required ? undefined : e.target.value)
                }
                className="h-8 font-mono text-xs"
              />
              {help}
            </div>
          );
        }

        // Arrays / objects: a per-field JSON island, so one gnarly field
        // doesn't force the whole call back to raw JSON.
        return (
          <div key={p.key} className="space-y-1">
            {label}
            <Textarea
              id={`arg-${p.key}`}
              rows={3}
              value={current === undefined ? '' : JSON.stringify(current, null, 2)}
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (raw === '') return setKey(p.key, undefined);
                try {
                  setKey(p.key, JSON.parse(raw) as unknown);
                } catch {
                  /* keep last valid value; the JSON tab can hold partial edits */
                }
              }}
              className="font-mono text-xs"
              placeholder="JSON value"
            />
            {help}
          </div>
        );
      })}
      {extraKeys.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          +{extraKeys.length} key{extraKeys.length === 1 ? '' : 's'} not in the schema (
          {extraKeys.slice(0, 4).join(', ')}
          {extraKeys.length > 4 ? ', …' : ''}) — kept as-is; edit in the JSON tab.
        </p>
      )}
    </div>
  );
}
