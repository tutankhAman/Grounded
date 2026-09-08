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
  errorMessage?: string | null;
  progress: {
    current: number;
    total: number;
  };
  stage?: DocumentStage;
  status: DocumentStatus;
}
