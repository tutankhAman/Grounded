import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { queryKeys } from "../lib/query";

export interface DocumentProgress {
  current: number;
  total: number;
}

export interface DocumentStatusEvent {
  elapsedMs?: number;
  error?: string;
  errorMessage?: string | null;
  progress?: DocumentProgress;
  stage?: string;
  status?: string;
}

export interface UseDocumentStatusReturn {
  error: string | null;
  errorMessage: string | null;
  /** Milliseconds remaining, extrapolated live so the countdown keeps moving
   * between progress events. Null while unknown (no timed progress yet),
   * finished, or failed. */
  etaMs: number | null;
  isClosed: boolean;
  isConnected: boolean;
  isTerminal: boolean;
  progress: DocumentProgress | null;
  reconnect: () => void;
  stage: string | null;
  status: string | null;
}

const TERMINAL_STATUSES = new Set(["done", "failed"]);
const HTTP_PREFIX_REGEX = /^http/;

function parseCloseEvent(code: number): {
  error: string | null;
  isTerminal: boolean;
} {
  if (code === 4400) {
    return { error: "Invalid document ID format", isTerminal: false };
  }
  if (code === 4404) {
    return { error: "Document not found", isTerminal: false };
  }
  if (code === 4413) {
    return {
      error: "Live updates unavailable. Click to reconnect.",
      isTerminal: false,
    };
  }
  if (code === 1000) {
    return { error: null, isTerminal: true };
  }
  return { error: "Connection lost. Click to reconnect.", isTerminal: false };
}

const OPEN_TIMEOUT_MS = 8000;

const devLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.debug("[doc-status]", ...args);
  }
};

export function useDocumentStatus(
  documentId: string | null | undefined,
  initialStatus?: string
): UseDocumentStatusReturn {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(initialStatus ?? null);
  const [progress, setProgress] = useState<DocumentProgress | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isTerminal, setIsTerminal] = useState(
    initialStatus ? TERMINAL_STATUSES.has(initialStatus) : false
  );
  const [retryNonce, setRetryNonce] = useState(0);
  // Last rate-derived estimate + when we received it. The displayed ETA
  // extrapolates from here so the countdown keeps moving during long,
  // event-quiet stretches (e.g. a 90s serial LLM batch).
  const [etaBase, setEtaBase] = useState<{
    etaMs: number;
    receivedAt: number;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const wsRef = useRef<WebSocket | null>(null);

  const reconnect = useCallback(() => {
    setError(null);
    setIsClosed(false);
    setRetryNonce((prev) => prev + 1);
  }, []);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const payload: DocumentStatusEvent = JSON.parse(event.data);
        if (payload.status) {
          setStatus(payload.status);
          if (TERMINAL_STATUSES.has(payload.status)) {
            setIsTerminal(true);
            setEtaBase(null);
          }
          if (payload.status === "done") {
            queryClient.invalidateQueries({ queryKey: queryKeys.documents() });
            queryClient.invalidateQueries({ queryKey: queryKeys.facts() });
          }
        }
        if (payload.progress) {
          setProgress(payload.progress);
          const { current, total } = payload.progress;
          if (
            typeof payload.elapsedMs === "number" &&
            Number.isFinite(payload.elapsedMs) &&
            payload.elapsedMs >= 0 &&
            current > 0 &&
            total > current
          ) {
            setEtaBase({
              etaMs: (payload.elapsedMs * (total - current)) / current,
              receivedAt: Date.now(),
            });
          } else {
            setEtaBase(null);
          }
        }
        if (payload.stage) {
          setStage(payload.stage);
        }
        if (payload.errorMessage !== undefined) {
          setErrorMessage(payload.errorMessage);
        }
        if (payload.error) {
          setError(payload.error);
        }
      } catch {
        // ignore non-JSON message
      }
    },
    [queryClient]
  );

  useEffect(() => {
    if (!documentId) {
      return;
    }
    setEtaBase(null);

    if (
      initialStatus &&
      TERMINAL_STATUSES.has(initialStatus) &&
      retryNonce === 0
    ) {
      setIsTerminal(true);
      setStatus(initialStatus);
      return;
    }

    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const wsBaseUrl = apiUrl.replace(HTTP_PREFIX_REGEX, "ws");
    const wsUrl = `${wsBaseUrl}/documents/${documentId}/status`;
    devLog("connecting", { documentId, wsUrl });

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    // If the handshake never completes (server accepted TCP but stalls),
    // fail visibly instead of hanging forever with no error shown.
    const openTimer = setTimeout(() => {
      if (wsRef.current === ws) {
        devLog("open timeout, closing", { documentId });
        try {
          ws.close();
        } catch {
          // Already closed — onclose will handle state.
        }
      }
    }, OPEN_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(openTimer);
      devLog("open", { documentId });
      setIsConnected(true);
      setError(null);
    };

    ws.onmessage = handleMessage;

    ws.onerror = () => {
      // onclose always follows with the code; log here so handshake-level
      // failures are distinguishable from clean closes in devtools.
      devLog("error", { documentId });
    };

    // NOTE: onclose fires for our own cleanup closes too (effect re-run on
    // new initialStatus, unmount, reconnect). A closing socket that is no
    // longer the current one is stale by definition — ignoring it is what
    // prevents the false "Connection lost" banner after clean teardown.
    // Identity comparison (not a boolean flag) is race-free under StrictMode
    // double-effects: the stale socket's async close event can land after the
    // replacement effect has already run.
    ws.onclose = (event) => {
      if (wsRef.current !== ws) {
        return;
      }
      wsRef.current = null;
      clearTimeout(openTimer);
      devLog("close", { code: event.code, documentId, reason: event.reason });
      setIsConnected(false);
      setIsClosed(true);
      setEtaBase(null);
      const closeResult = parseCloseEvent(event.code);
      if (closeResult.error) {
        setError(closeResult.error);
      }
      if (closeResult.isTerminal) {
        setIsTerminal(true);
      }
    };

    return () => {
      // Detach first so this socket's close event is recognized as intentional.
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      try {
        ws.close();
      } catch {
        // Already closed — nothing to do.
      }
    };
  }, [documentId, handleMessage, initialStatus, retryNonce]);

  // Tick the displayed ETA once per second while an estimate is live, so the
  // countdown moves even when no progress events arrive for a while.
  useEffect(() => {
    if (isTerminal || etaBase === null) {
      return;
    }
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [isTerminal, etaBase]);

  const etaMs =
    etaBase === null || isTerminal
      ? null
      : Math.max(0, etaBase.etaMs - (nowMs - etaBase.receivedAt));

  return {
    error,
    errorMessage,
    etaMs,
    isClosed,
    isConnected,
    isTerminal,
    progress,
    reconnect,
    stage,
    status,
  };
}
