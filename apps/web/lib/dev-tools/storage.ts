/**
 * localStorage persistence for the API Console — saved requests, history,
 * environments. Mirrors the approach proven in master (DFM): console
 * state is operator-local scratch, not shared data, so the browser is the
 * right home for it. Secrets are scrubbed before anything is persisted.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DraftRequest,
  Environment,
  HistoryEntry,
  KeyValueEntry,
} from './types';

export const STORAGE_KEYS = {
  environments: 'dev-tools:environments:v1',
  activeEnvId: 'dev-tools:active-env:v1',
  collections: 'dev-tools:collections:v1',
  history: 'dev-tools:history:v1',
} as const;

export const HISTORY_LIMIT = 200;

export function genId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

export function emptyKv(): KeyValueEntry {
  return { id: genId('kv'), enabled: true, key: '', value: '' };
}

export function defaultEnvironments(): Environment[] {
  return [
    { id: 'env_local', name: 'This server', baseUrl: '', vars: [] },
  ];
}

export function emptyDraft(): DraftRequest {
  return {
    kind: 'http',
    name: 'Untitled request',
    method: 'GET',
    url: '{{baseUrl}}/api/health',
    params: [],
    headers: [],
    body: { mode: 'none', text: '' },
    auth: { mode: 'session' },
    pathValues: {},
    targetName: '',
    argsText: '{}',
  };
}

/** Blank bearer tokens + Authorization headers before persisting. */
export function scrubDraftSecrets(d: DraftRequest): DraftRequest {
  return {
    ...d,
    auth: { ...d.auth, token: d.auth.token ? '' : d.auth.token },
    headers: d.headers.map((h) =>
      h.key.toLowerCase() === 'authorization' ? { ...h, value: '' } : h,
    ),
  };
}

/**
 * useState backed by localStorage. Reads lazily on mount (SSR-safe),
 * writes on change. Storage failures (quota, private mode) degrade to
 * in-memory state silently — it's a dev console, not a datastore.
 */
export function usePersistedState<T>(
  key: string,
  initial: () => T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* keep initial */
    }
    loaded.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* in-memory only */
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}

export function appendHistory(prev: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...prev].slice(0, HISTORY_LIMIT);
}
