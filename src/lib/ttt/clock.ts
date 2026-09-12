/**
 * Clock helpers for TTT authenticated requests (±30s server window).
 */
export function isWithinSkew(serverNowMs: number, requestTsMs: number, windowMs = 30_000): boolean {
  return Math.abs(serverNowMs - requestTsMs) <= windowMs;
}
