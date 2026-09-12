/**
 * Multi-timeframe model. Every TF maps to a native TTT UDF resolution.
 * RUNTIME VERIFIED 2026-09-05 against https://apiv2.thetruetrade.io:
 * resolutions 1,5,15,30,45,60,120,240,480 AND the documented '1D' are all
 * served natively (s:"ok"). Therefore AsA NEVER silently derives 1D from 8H:
 * 1D is requested natively. A labeled 8H->1D derivation exists only as an
 * explicitly marked fallback (see ttt/udf.ts).
 */
export const TIMEFRAMES = [
  { id: "1m",  minutes: 1,    tttResolution: "1",  backfillTarget: 500 },
  { id: "5m",  minutes: 5,    tttResolution: "5",  backfillTarget: 500 },
  { id: "15m", minutes: 15,   tttResolution: "15", backfillTarget: 700 },
  { id: "30m", minutes: 30,   tttResolution: "30", backfillTarget: 400 },
  { id: "45m", minutes: 45,   tttResolution: "45", backfillTarget: 400 },
  { id: "1h",  minutes: 60,   tttResolution: "60", backfillTarget: 800 },
  { id: "2h",  minutes: 120,  tttResolution: "120", backfillTarget: 600 },
  { id: "4h",  minutes: 240,  tttResolution: "240", backfillTarget: 900 },
  { id: "8h",  minutes: 480,  tttResolution: "480", backfillTarget: 600 },
  { id: "1d",  minutes: 1440, tttResolution: "1D", backfillTarget: 320 },
] as const;

export type TimeframeId = (typeof TIMEFRAMES)[number]["id"];

/** Core hierarchy: 4H macro, 1H context, 15M setup/trigger. */
export const CORE_TFS: readonly TimeframeId[] = ["4h", "1h", "15m"];

const TF_INDEX = new Map<string, (typeof TIMEFRAMES)[number]>();
for (const tf of TIMEFRAMES) TF_INDEX.set(tf.id, tf);

export function getTimeframe(id: string): (typeof TIMEFRAMES)[number] | undefined {
  return TF_INDEX.get(id);
}

export function assertTimeframe(id: string, ctx = "timeframe"): TimeframeId {
  const tf = TF_INDEX.get(id);
  if (!tf) throw new Error(`[tf] unsupported timeframe '${id}' (${ctx})`);
  return tf.id as TimeframeId;
}

export function isTimeframe(id: string): id is TimeframeId {
  return TF_INDEX.has(id);
}

export const TIMEFRAME_IDS: readonly TimeframeId[] = TIMEFRAMES.map((t) => t.id);

export const MINUTE_MS = 60_000;

/** Align an epoch-ms timestamp down to the start of the given timeframe. */
export function tfStartMs(ms: number, tf: TimeframeId): number {
  const min = TF_INDEX.get(tf)!.minutes;
  return Math.floor(ms / (min * MINUTE_MS)) * (min * MINUTE_MS);
}
