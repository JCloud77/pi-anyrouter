export function isRetryableStatus(status: number) {
  return [408, 409, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
}

export function parseRetryAfterMs(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  if (Number.isFinite(at)) {
    const delta = at - now;
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

export function getRetryDelayMs(attempt: number, retryAfterMs?: number, jitter = Math.floor(Math.random() * 250)) {
  if (typeof retryAfterMs === "number") return Math.max(0, Math.min(retryAfterMs, 30_000));
  const base = Math.min(1000 * (2 ** attempt), 15_000);
  return base + Math.max(0, Math.min(jitter, 249));
}
