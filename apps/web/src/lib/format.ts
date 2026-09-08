/**
 * Formats a remaining-time estimate for display next to progress bars.
 * Returns null when there is nothing sensible to show (unknown ETA).
 */
export const formatEta = (etaMs: number | null): string | null => {
  if (etaMs === null || !Number.isFinite(etaMs)) {
    return null;
  }
  const totalSeconds = Math.max(0, Math.round(etaMs / 1000));
  if (totalSeconds < 5) {
    return "almost done";
  }
  if (totalSeconds < 60) {
    return `≈ ${totalSeconds}s left`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0
      ? `≈ ${minutes}m left`
      : `≈ ${minutes}m ${seconds}s left`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `≈ ${hours}h ${restMinutes}m left`;
};
