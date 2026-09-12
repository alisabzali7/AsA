# Direction resolutions (closure §A5)

The Brain compiler audits every entry field: a field's NAME is never trusted as
evidence of trade direction. Where the source label and the stated action
disagree, or where a generic field states a side with no label, the spec is
flagged with a `direction_anomaly` and is NOT auto-executable.

Each anomaly must be resolved EXPLICITLY in the compiled strategy, with the
reasoning recorded here. The runtime `auditDirection()` guard then re-verifies
the decision on every build; a mismatch downgrades the strategy to DISABLED
rather than silently inverting a trade.

## Resolved

| strategy | anomaly | resolution | evidence |
|---|---|---|---|
| `STR-RAW-4-2425` (هارمونیک پایه AB=CD) | generic `entry` field states `ورود به معامله سل` (a SELL action) with no directional label | declared **short** in `harmonic-abcd.ts` | `سل` = sell; the pattern completes at D after a deep correction, and the source describes "اولین ورود فروشندگان" (first entry of sellers) as the confirmation |

## Unresolved

None. Any future anomaly must appear in this table before its strategy may be
marked EXECUTABLE.
