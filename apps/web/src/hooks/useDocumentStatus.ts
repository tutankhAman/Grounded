import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { queryKeys } from "../lib/query";

export interface DocumentProgress {
  current: number;
  total: number;
}

export interface DocumentStatusEvent {
  error?: string;
  errorMessage?: string | null;
  progress?: DocumentProgress;
  stage?: string;
  status?: string;
}

export interface UseDocumentStatusReturn {
  error: string | null;
  errorMessage: string | null;
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
  if (code === 1000) {
    return { error: null, isTerminal: true };
  }
  return { error: "Connection lost. Click to reconnect.", isTerminal: false };
}

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
          }
          if (payload.status === "done") {
            queryClient.invalidateQueries({ queryKey: queryKeys.documents() });
            queryClient.invalidateQueries({ queryKey: queryKeys.facts() });
          }
        }
        if (payload.progress) {
          setProgress(payload.progress);
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

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    ws.onmessage = handleMessage;

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
      setIsConnected(false);
      setIsClosed(true);
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

  return {
    error,
    errorMessage,
    isClosed,
    isConnected,
    isTerminal,
    progress,
    reconnect,
    stage,
    status,
  };
}
