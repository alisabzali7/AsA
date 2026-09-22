/**
 * Deterministic fake TTT UDF venue (test-only).
 *
 * Real SQLite is not required and no network is touched: this builds a
 * CONCRETE bar list and answers `/futures/udf/history` requests from it, so a
 * test can state exactly what the venue holds, what it serves, and how it
 * misbehaves — then assert what the walk is allowed to conclude.
 *
 * Response contract mirrored from the live venue:
 *   - bars inside the requested window          -> { s:"ok", t/o/h/l/c/v }
 *   - nothing inside the requested window       -> { s:"no_data" }
 *   - both are HTTP 200 (no_data is NOT an HTTP error)
 */
import { vi } from "vitest";
import type { Candle } from "../../../src/lib/domain/types";

export interface VenueBarSpec {
  /** bars are spaced by this many seconds */
  stepSec: number;
  /** the OLDEST bar the venue holds (its true boundary) */
  earliest: number;
  /** how many bars the venue holds, walking forward from `earliest` */
  count: number;
  /** timestamps (epoch seconds) the venue does NOT hold — genuine venue gaps */
  holes?: number[];
}

export interface VenueBehavior {
  /**
   * Venue response cap: serve at most this many bars per request (the REAL
   * venue caps a UDF response at ~5000). Lets a test force a multi-chunk walk.
   */
  maxBarsPerResponse?: number;
  /**
   * What the venue answers when asked for a window entirely OLDER than
   * everything it holds. Default `"no_data"` — the authoritative boundary
   * answer. `"repeat_newest"` mimics a venue that IGNORES the window and serves
   * its newest bars again (pure overlap, no boundary signal).
   */
  belowOldest?: "no_data" | "ok_empty" | "repeat_newest" | "http500" | "network";
  /** ignore `from`/`to` and always answer with the newest window (window clamping) */
  ignoreWindow?: boolean;
  /** answer s:"ok" with empty arrays for every window */
  okEmpty?: boolean;
  /** answer s:"no_data" for every window */
  alwaysNoData?: boolean;
  /** fail every request: thrown TypeError (network) or an HTTP status */
  failure?: null | "network" | "http500" | "http429";
  /** force s:"no_data" for windows intersecting any of these ranges */
  noDataWindows?: { from: number; to: number }[];
  /**
   * Emit bars whose OHLC is structurally unparseable-as-valid (o = h = l = c = 0).
   * The UDF payload still parses (arrays are well-formed), but
   * `validateCandles` rejects every bar — the case that must NEVER be read as
   * boundary evidence.
   */
  invalidPrices?: boolean;
  /** Emit the arrays in DESCENDING time order (venue payload ordering change). */
  descending?: boolean;
}

export interface RecordedRequest {
  from: number;
  to: number;
  resolution: string;
  symbol: string;
}

export interface FakeVenue {
  /** every request the walk actually made, in order */
  requests: RecordedRequest[];
  /** the full bar list the venue holds (the ground truth a test asserts against) */
  held: Candle[];
  /** epoch seconds the venue holds — the ONLY timestamps that may ever be stored */
  heldTimestamps(): number[];
  setBehavior(next: VenueBehavior): void;
  fetchImpl: (input: string | URL | Request) => Promise<Response>;
}

function bar(t: number, i: number): Candle {
  // deterministic, structurally valid OHLC (no randomness anywhere)
  const o = 100 + (i % 7);
  return { t, o, h: o + 2, l: o - 1, c: o + 1, v: 10 + (i % 5) };
}

export function makeFakeVenue(spec: VenueBarSpec, behavior: VenueBehavior = {}): FakeVenue {
  const holes = new Set(spec.holes ?? []);
  const held: Candle[] = [];
  for (let i = 0; i < spec.count; i++) {
    const t = spec.earliest + i * spec.stepSec;
    if (holes.has(t)) continue;
    held.push(bar(t, i));
  }

  const state: VenueBehavior = { ...behavior };
  const requests: RecordedRequest[] = [];

  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const q = url.searchParams;
    const req: RecordedRequest = {
      symbol: q.get("symbol") ?? "",
      resolution: q.get("resolution") ?? "",
      from: Number(q.get("from")),
      to: Number(q.get("to")),
    };
    requests.push(req);

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    /** Serialize bars honouring the payload-shape behaviours above. */
    const barsPayload = (bars: Candle[]): Response => {
      const ordered = state.descending ? [...bars].reverse() : bars;
      const o = ordered.map((c) => (state.invalidPrices ? 0 : c.o));
      const h = ordered.map((c) => (state.invalidPrices ? 0 : c.h));
      const l = ordered.map((c) => (state.invalidPrices ? 0 : c.l));
      const c = ordered.map((bar) => (state.invalidPrices ? 0 : bar.c));
      return json({ s: "ok", t: ordered.map((b) => b.t), o, h, l, c, v: ordered.map((b) => b.v) });
    };

    if (state.failure === "network") throw new TypeError("fetch failed");
    if (state.failure === "http500") return json({ errors: [{ message: "boom" }] }, 500);
    if (state.failure === "http429") return json({ errors: [{ message: "rate limit" }] }, 429);
    if (state.alwaysNoData) return json({ s: "no_data" });
    if (state.okEmpty) return json({ s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] });
    if ((state.noDataWindows ?? []).some((w) => req.from <= w.to && req.to >= w.from)) {
      return json({ s: "no_data" });
    }

    if (state.ignoreWindow) {
      // the venue never honours the requested window: it always answers with its
      // newest bars, so it can never say "there is nothing older"
      const newest = held.slice(-Math.min(held.length, 5000));
      if (newest.length === 0) return json({ s: "no_data" });
      return barsPayload(newest);
    }

    const oldestHeld = held.length ? held[0].t : Infinity;
    if (req.to < oldestHeld) {
      // the venue was asked for data older than everything it holds
      const mode = state.belowOldest ?? "no_data";
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "http500") return json({ errors: [{ message: "boom" }] }, 500);
      if (mode === "ok_empty") return json({ s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] });
      if (mode === "repeat_newest") {
        return barsPayload(held.slice(-Math.min(held.length, 5000))); // window ignored
      }
      return json({ s: "no_data" });
    }

    let window = held.filter((c) => c.t >= req.from && c.t <= req.to);
    // the venue caps how many bars one response may carry (newest first)
    if (state.maxBarsPerResponse !== undefined) window = window.slice(-state.maxBarsPerResponse);

    if (window.length === 0) return json({ s: "no_data" }); // authoritative: nothing in that window
    return barsPayload(window);
  };

  return {
    requests,
    held,
    heldTimestamps: () => held.map((c) => c.t),
    setBehavior(next: VenueBehavior) {
      Object.assign(state, next);
      for (const k of [
        "ignoreWindow", "okEmpty", "alwaysNoData", "failure", "noDataWindows",
        "invalidPrices", "descending", "maxBarsPerResponse", "belowOldest",
      ] as const) {
        if (!(k in next)) delete state[k];
      }
    },
    fetchImpl,
  };
}

/** Install the venue as the process-wide fetch. */
export function stubVenue(venue: FakeVenue): void {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => venue.fetchImpl(input)));
}
