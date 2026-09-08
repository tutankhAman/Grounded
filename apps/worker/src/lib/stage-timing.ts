/**
 * Per-document stage stopwatch for progress events.
 *
 * Each BullMQ job handles exactly one pipeline stage, but a single worker
 * process runs many jobs concurrently — so stage starts live in a map keyed
 * by document id rather than module state. Entries are cleared when a
 * terminal event for the document is published; a stale entry (e.g. worker
 * crash) is simply overwritten by the next run and can only leak a number.
 */
const stageStarts = new Map<string, number>();

export const startStage = (documentId: string, nowMs = Date.now()): void => {
  stageStarts.set(documentId, nowMs);
};

export const stageElapsedMs = (
  documentId: string,
  nowMs = Date.now()
): number | undefined => {
  const startedAt = stageStarts.get(documentId);
  if (startedAt === undefined) {
    return undefined;
  }
  return Math.max(0, nowMs - startedAt);
};

export const endStage = (documentId: string): void => {
  stageStarts.delete(documentId);
};
