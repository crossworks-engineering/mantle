'use client';

/**
 * State provider for the API Console. Owns the draft request, the active
 * response, environments, saved requests, history (all localStorage), the
 * live MCP catalog (lazy-fetched — first hit boots the MCP server), and
 * the agent-tool list (server-seeded, refreshed after saves).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  sendHttpDraft,
  sendMcpCall,
  sendToolCall,
} from '@/lib/dev-tools/client';
import {
  STORAGE_KEYS,
  appendHistory,
  defaultEnvironments,
  emptyDraft,
  genId,
  scrubDraftSecrets,
  usePersistedState,
} from '@/lib/dev-tools/storage';
import type {
  AgentToolInfo,
  ConsoleResponse,
  DraftRequest,
  Environment,
  HistoryEntry,
  McpToolInfo,
  SavedCollection,
  SavedRequest,
} from '@/lib/dev-tools/types';

type McpState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; tools: McpToolInfo[] }
  | { status: 'error'; error: string };

type DevToolsContextValue = {
  environments: Environment[];
  setEnvironments: (next: Environment[]) => void;
  activeEnv: Environment | null;
  activeEnvId: string | null;
  setActiveEnvId: (id: string) => void;

  collections: SavedCollection[];
  saveDraftTo: (collectionId: string | null, name: string) => void; // null → new collection
  deleteSaved: (collectionId: string, requestId: string) => void;
  deleteCollection: (collectionId: string) => void;

  history: HistoryEntry[];
  clearHistory: () => void;

  draft: DraftRequest;
  setDraft: (updater: (d: DraftRequest) => DraftRequest) => void;
  replaceDraft: (d: DraftRequest) => void;

  response: ConsoleResponse | null;
  sending: boolean;
  send: () => Promise<void>;
  cancel: () => void;

  mcp: McpState;
  loadMcpTools: () => void;

  agentTools: AgentToolInfo[];
  refreshAgentTools: () => Promise<void>;

  /** Toolsmith Assist panel visibility (toggled from the builder header). */
  assistOpen: boolean;
  setAssistOpen: (open: boolean) => void;
};

const Ctx = createContext<DevToolsContextValue | null>(null);

export function useDevTools(): DevToolsContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDevTools outside DevToolsProvider');
  return v;
}

export function DevToolsProvider({
  initialAgentTools,
  children,
}: {
  initialAgentTools: AgentToolInfo[];
  children: React.ReactNode;
}) {
  const [environments, setEnvironments] = usePersistedState<Environment[]>(
    STORAGE_KEYS.environments,
    defaultEnvironments,
  );
  const [activeEnvId, setActiveEnvId] = usePersistedState<string | null>(
    STORAGE_KEYS.activeEnvId,
    () => 'env_local',
  );
  const [collections, setCollections] = usePersistedState<SavedCollection[]>(
    STORAGE_KEYS.collections,
    () => [],
  );
  const [history, setHistory] = usePersistedState<HistoryEntry[]>(
    STORAGE_KEYS.history,
    () => [],
  );

  const [draft, setDraftState] = useState<DraftRequest>(emptyDraft);
  const [response, setResponse] = useState<ConsoleResponse | null>(null);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [mcp, setMcp] = useState<McpState>({ status: 'idle' });
  const [agentTools, setAgentTools] = useState<AgentToolInfo[]>(initialAgentTools);
  const [assistOpen, setAssistOpen] = useState(false);

  const activeEnv = useMemo(
    () => environments.find((e) => e.id === activeEnvId) ?? environments[0] ?? null,
    [environments, activeEnvId],
  );

  const setDraft = useCallback(
    (updater: (d: DraftRequest) => DraftRequest) => setDraftState(updater),
    [],
  );
  const replaceDraft = useCallback((d: DraftRequest) => {
    setDraftState(d);
    setResponse(null);
  }, []);

  const loadMcpTools = useCallback(() => {
    setMcp((prev) => {
      if (prev.status === 'loading' || prev.status === 'ready') return prev;
      void (async () => {
        try {
          const res = await fetch('/api/dev-tools/mcp');
          const payload = (await res.json()) as { tools?: McpToolInfo[]; error?: string };
          if (!res.ok || !payload.tools) {
            setMcp({ status: 'error', error: payload.error ?? 'failed to list MCP tools' });
            return;
          }
          setMcp({ status: 'ready', tools: payload.tools });
        } catch (err) {
          setMcp({
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return { status: 'loading' };
    });
  }, []);

  const refreshAgentTools = useCallback(async () => {
    try {
      const res = await fetch('/api/tools');
      const payload = (await res.json()) as { tools?: AgentToolInfo[] };
      if (res.ok && payload.tools) setAgentTools(payload.tools);
    } catch {
      /* keep the stale list */
    }
  }, []);

  const send = useCallback(async () => {
    if (sending) return;
    setSending(true);
    setResponse(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let res: ConsoleResponse;
      let label: string;
      if (draft.kind === 'http') {
        res = await sendHttpDraft(draft, activeEnv, controller.signal);
        label = `${draft.method} ${draft.url}`;
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = draft.argsText.trim() ? (JSON.parse(draft.argsText) as Record<string, unknown>) : {};
        } catch {
          setResponse({
            via: draft.kind,
            status: 0,
            statusText: 'Invalid args',
            ok: false,
            durationMs: 0,
            sizeBytes: 0,
            headers: [],
            bodyText: '',
            json: null,
            networkError: 'Args is not valid JSON.',
            startedAt: new Date().toISOString(),
          });
          return;
        }
        res =
          draft.kind === 'tool'
            ? await sendToolCall(draft.targetName, args, controller.signal)
            : await sendMcpCall(draft.targetName, args, controller.signal);
        label = `${draft.kind}:${draft.targetName}`;
      }
      setResponse(res);
      setHistory((prev) =>
        appendHistory(prev, {
          id: genId('hist'),
          at: Date.now(),
          kind: draft.kind,
          label,
          method: draft.kind === 'http' ? draft.method : undefined,
          status: res.status,
          ok: res.ok,
          durationMs: res.durationMs,
          draft: scrubDraftSecrets(draft),
        }),
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setResponse({
          via: draft.kind === 'http' ? 'direct' : draft.kind,
          status: 0,
          statusText: 'Error',
          ok: false,
          durationMs: 0,
          sizeBytes: 0,
          headers: [],
          bodyText: '',
          json: null,
          networkError: err instanceof Error ? err.message : String(err),
          startedAt: new Date().toISOString(),
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [sending, draft, activeEnv, setHistory]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const saveDraftTo = useCallback(
    (collectionId: string | null, name: string) => {
      const saved: SavedRequest = {
        ...scrubDraftSecrets(draft),
        name,
        id: genId('req'),
        savedAt: Date.now(),
      };
      setCollections((prev) => {
        if (collectionId === null) {
          return [
            ...prev,
            { id: genId('col'), name: 'My requests', requests: [saved] },
          ];
        }
        return prev.map((c) =>
          c.id === collectionId ? { ...c, requests: [...c.requests, saved] } : c,
        );
      });
    },
    [draft, setCollections],
  );

  const deleteSaved = useCallback(
    (collectionId: string, requestId: string) => {
      setCollections((prev) =>
        prev.map((c) =>
          c.id === collectionId
            ? { ...c, requests: c.requests.filter((r) => r.id !== requestId) }
            : c,
        ),
      );
    },
    [setCollections],
  );

  const deleteCollection = useCallback(
    (collectionId: string) => {
      setCollections((prev) => prev.filter((c) => c.id !== collectionId));
    },
    [setCollections],
  );

  const clearHistory = useCallback(() => setHistory([]), [setHistory]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const value: DevToolsContextValue = {
    environments,
    setEnvironments,
    activeEnv,
    activeEnvId,
    setActiveEnvId,
    collections,
    saveDraftTo,
    deleteSaved,
    deleteCollection,
    history,
    clearHistory,
    draft,
    setDraft,
    replaceDraft,
    response,
    sending,
    send,
    cancel,
    mcp,
    loadMcpTools,
    agentTools,
    refreshAgentTools,
    assistOpen,
    setAssistOpen,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
