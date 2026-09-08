import {
  type DocumentProgressEvent,
  type DocumentStage,
  type DocumentStatus,
  TERMINAL_STATUSES,
  type TerminalStatus,
} from "@grounded/db";

const VALID_STAGES = new Set<DocumentStage>([
  "parse",
  "extract",
  "resolve",
  "reconcile",
]);

const VALID_STATUSES = new Set<DocumentStatus>([
  "pending",
  "parsing",
  "parsed",
  "extracting",
  "extracted",
  "resolving",
  "resolved",
  "reconciling",
  "done",
  "failed",
]);

export const isTerminalStatus = (status: unknown): status is TerminalStatus =>
  typeof status === "string" &&
  (TERMINAL_STATUSES as readonly string[]).includes(status);

export const isProgressEvent = (
  value: unknown
): value is DocumentProgressEvent => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.status !== "string" ||
    !VALID_STATUSES.has(candidate.status as DocumentStatus)
  ) {
    return false;
  }

  if (
    !candidate.progress ||
    typeof candidate.progress !== "object" ||
    typeof (candidate.progress as Record<string, unknown>).current !==
      "number" ||
    typeof (candidate.progress as Record<string, unknown>).total !== "number"
  ) {
    return false;
  }

  const { current, total } = candidate.progress as {
    current: number;
    total: number;
  };
  if (!(Number.isFinite(current) && Number.isFinite(total))) {
    return false;
  }

  if (
    candidate.stage !== undefined &&
    (typeof candidate.stage !== "string" ||
      !VALID_STAGES.has(candidate.stage as DocumentStage))
  ) {
    return false;
  }

  if (
    candidate.errorMessage !== undefined &&
    candidate.errorMessage !== null &&
    typeof candidate.errorMessage !== "string"
  ) {
    return false;
  }

  return true;
};
