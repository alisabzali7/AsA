# History vs Viewport Report

Three concepts, explicitly named in code and never conflated:

| Concept | Meaning | Where |
|---|---|---|
| `DURABLE_HISTORY` | every candle TTT has, to the venue boundary | `history.db` (775,081 bars) |
| `COMPUTE_WINDOW` | bounded live window for runtime computation | `/api/market/candles` |
| `CHART_VIEWPORT` | what is currently rendered | `chart-view.tsx` |

## Progressive loading (new)

The chart renders an initial bounded viewport, then pages older
`DURABLE_HISTORY` from `/api/market/history` as the user scrolls left:

- `subscribeVisibleLogicalRangeChange` triggers `loadOlder()` at the left edge
- pages are deduplicated by timestamp and kept ascending
- history is bucketed per `symbol|timeframe`
- the UI shows `loading older…`, `scroll left for more`, `TTT boundary reached`
  and the earliest available date

A viewport limit is never a retention limit: the backend applies no default
`limit`, and `transport_window_applied` reports when one was requested.
