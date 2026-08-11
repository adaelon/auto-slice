const MINUTE_MS = 60_000;
const FIXED_PROBE_ELAPSED_MS = [
  20 * MINUTE_MS,
  30 * MINUTE_MS,
  35 * MINUTE_MS,
  40 * MINUTE_MS,
] as const;
const FORTY_MINUTES_MS = 40 * MINUTE_MS;
const LATE_PROBE_INTERVAL_MS = 2 * MINUTE_MS;

export function nextCompactionProbeElapsedMs(
  elapsedMs: number,
  includeCurrent: boolean = true,
): number {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("Compaction probe elapsed time must be a non-negative safe integer.");
  }
  for (const candidate of FIXED_PROBE_ELAPSED_MS) {
    if (candidate > elapsedMs || (includeCurrent && candidate === elapsedMs)) {
      return candidate;
    }
  }
  const elapsedAfterForty = elapsedMs - FORTY_MINUTES_MS;
  const intervals = Math.max(1, Math.ceil(elapsedAfterForty / LATE_PROBE_INTERVAL_MS));
  const candidate = FORTY_MINUTES_MS + intervals * LATE_PROBE_INTERVAL_MS;
  return !includeCurrent && candidate === elapsedMs
    ? candidate + LATE_PROBE_INTERVAL_MS
    : candidate;
}
