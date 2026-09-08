export type DocumentStatus =
  | "pending"
  | "parsing"
  | "parsed"
  | "extracting"
  | "extracted"
  | "resolving"
  | "resolved"
  | "reconciling"
  | "done"
  | "failed";

export type DocumentStage = "parse" | "extract" | "resolve" | "reconcile";

export const TERMINAL_STATUSES = ["done", "failed"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface DocumentProgressEvent {
  /**
   * Milliseconds elapsed since the current stage started (measured by the
   * worker that published this event). Used by clients to estimate remaining
   * time as `elapsedMs * (total - current) / current`. Omitted when unknown
   * (e.g. snapshots built from DB state, which has no stage-start time).
   */
  elapsedMs?: number;
  errorMessage?: string | null;
  progress: {
    current: number;
    total: number;
  };
  stage?: DocumentStage;
  status: DocumentStatus;
}
