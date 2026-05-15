/**
 * Shared sort definitions for the inbox. Pure helpers only — no React,
 * no `'use client'` — so the server component (page.tsx) and the client
 * toolbar can both import from here without crossing the server/client
 * boundary.
 */

export const SORT_OPTIONS = [
  { value: 'date_desc', label: 'Newest first' },
  { value: 'date_asc', label: 'Oldest first' },
  { value: 'ingested_desc', label: 'Recently added' },
  { value: 'from_asc', label: 'From (A–Z)' },
] as const;

export type SortKey = (typeof SORT_OPTIONS)[number]['value'];

export const DEFAULT_SORT: SortKey = 'date_desc';

export function parseSort(raw: string | undefined): SortKey {
  return SORT_OPTIONS.find((o) => o.value === raw)?.value ?? DEFAULT_SORT;
}
