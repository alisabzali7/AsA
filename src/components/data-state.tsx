"use client";
/** TruthState — the shared data-state primitive (design system §23).
 *
 * One honest renderer for every async surface. It NEVER upgrades a state:
 *   LOADING      only while a first request is genuinely in flight
 *   UNAVAILABLE  the server's own "not available" verdict, with its reason
 *   OFFLINE      the browser has no network — nothing received, nothing faked
 *   ERROR        unexpected failure (transport/server), message shown verbatim
 *   EMPTY        the backend answered successfully and the result is truly empty
 *
 * Colors are never the only signal: every variant carries a word label.
 */
import { useLang } from "./lang";
import { fmtAge } from "./hooks";
import type { ResourceFailure, ResourceStatus } from "./resource-state";
import { StatusChip } from "./ui";
import { IconRefresh, IconVoid } from "./icons";

export function TruthState({
  status,
  failure,
  onRetry,
  staleAgeMs,
  emptyText,
  loadingText,
  dense = false,
}: {
  /** provider status, or "EMPTY" when the feature has derived a true empty result */
  status: ResourceStatus | "EMPTY";
  failure: ResourceFailure | null;
  onRetry?: () => void;
  /** age of the last good payload, when data is retained while degraded */
  staleAgeMs?: number | null;
  /** text for the EMPTY case (supplied only when the feature knows the backend answered empty) */
  emptyText?: string;
  loadingText?: string;
  dense?: boolean;
}) {
  const { t } = useLang();
  if (status === "OK") return null;

  const pad = dense ? "px-2 py-1" : "px-3 py-2.5";
  const retry = onRetry && status !== "LOADING" ? (
    <button className="focus-ring btn group/retry px-2 py-0.5 text-[10px]" onClick={onRetry}>
      <span className="transition-transform duration-[var(--t-short)] group-hover/retry:rotate-180" aria-hidden><IconRefresh size={10} /></span>
      {t("state", "retry")}
    </button>
  ) : null;

  if (status === "LOADING") {
    return (
      <div role="status" aria-live="polite" className={`rise panel-2 flex items-center gap-2 ${pad} text-[11.5px] text-muted`}>
        <span aria-hidden className="breathe inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-muted)" }} />
        {loadingText ?? t("state", "loading")}
      </div>
    );
  }

  if (status === "EMPTY") {
    return (
      <div className={`rise panel-2 ${pad} flex items-center gap-2 text-[11.5px] text-muted`} role="status">
        <span className="text-dim" aria-hidden><IconVoid size={14} /></span>
        {emptyText ?? t("state", "empty")}
      </div>
    );
  }

  const label =
    status === "UNAVAILABLE" ? t("state", "unavailable") : status === "OFFLINE" ? t("state", "offline") : t("state", "error");
  const chip = status === "UNAVAILABLE" ? "UNAVAILABLE" : status === "OFFLINE" ? "OFFLINE" : "ERROR";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`panel-2 flex flex-wrap items-center gap-x-2 gap-y-1 ${pad}`}
      style={{ borderColor: status === "UNAVAILABLE" || status === "OFFLINE" ? "rgba(223,168,79,0.30)" : "rgba(228,106,104,0.30)" }}
    >
      <StatusChip state={chip} label={label} />
      {failure?.server_state && (
        <span dir="ltr" className="mono rounded border px-1 py-0.5 text-[9.5px] font-semibold" style={{ borderColor: "var(--color-line-2)", color: "var(--color-warn)" }}>
          {failure.server_state}
        </span>
      )}
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted" dir="auto">
        {failure?.message ?? "—"}
        {failure?.hint && <span className="block text-[10px] text-dim">↳ {failure.hint}</span>}
      </span>
      {typeof staleAgeMs === "number" && (
        <span className="mono text-[10px]" style={{ color: "var(--color-warn)" }}>
          {t("state", "cachedFor")} <span dir="ltr">{fmtAge(staleAgeMs)}</span> · {t("state", "notLive")}
        </span>
      )}
      {retry}
    </div>
  );
}

/** Inline status word for compact places (metric cards, table captions). */
export function StatusWord({ status, failure }: { status: ResourceStatus; failure?: ResourceFailure | null }) {
  const { t } = useLang();
  const map: Record<ResourceStatus, string> = {
    LOADING: t("state", "loading"),
    OK: "READY",
    UNAVAILABLE: t("state", "unavailable"),
    OFFLINE: t("state", "offline"),
    ERROR: t("state", "error"),
  };
  return (
    <span title={failure?.server_state ?? failure?.message ?? undefined} className="font-semibold uppercase tracking-wider">
      {map[status]}
      {failure?.server_state ? ` · ${failure.server_state}` : ""}
    </span>
  );
}
