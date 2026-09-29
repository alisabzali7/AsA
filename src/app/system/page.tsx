"use client";
/** System — observability surface (no secrets). TTT budget, lanes, coverage, AI/Telegram/News, retention. */
import { useLang } from "@/components/lang";
import { usePoll, fmtAge, stateColor } from "@/components/hooks";
import { Badge, Panel, StatusChip, Timeline } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";

interface StatusShape {
  ok: boolean; booted: boolean; boot_ms: number; phase: string;
  health: { market: string; reason?: string };
  last_stats_sweep_ms: number | null; stats_age_ms: number | null;
  live: { live: number; total: number };
  scheduler: { budget_per_min: number; configured_per_min: number; total_requests: number; total_429: number; paused: boolean; last_429_ms: number | null; current_waiters: number };
  candles: { queueDepth: number; fetchedTotal: number };
  catalog_symbols: number;
  ai: { id: string; configured: boolean; online: boolean | null; model: string | null }[];
  telegram: { state: string; reason?: string; configured: boolean; dry_run: boolean };
  news: { state: string; reason?: string; items_stored: number };
  storage: string; uptime_ms: number; ttt_errors: number;
}
interface LogsShape { errors: { at_ms: number; kind: string; endpoint: string; message: string }[]; retention_runs: { id: number; ran_ms: number; table_name: string; deleted: number; cutoff_ms: number; ok: number; note: string }[] }
interface EvShape { events: { type: string; ts: number }[] }

function Row({ k, v, color, title }: { k: string; v: string; color?: string; title?: string }) {
  return <div className="kv" title={title}><span className="text-muted">{k}</span><span className="mono iso" style={{ color }}>{v}</span></div>;
}

export default function SystemPage() {
  const { t } = useLang();
  const s = usePoll<StatusShape>("/api/system/status", 15_000);
  // Risk policy surface: the persisted prefs ARE the risk engine's inputs —
  // shown as stored values; "unset" stays "unset" (env defaults live server-side).
  const cfg = usePoll<{ ok: boolean; prefs: Record<string, string> }>("/api/system/config", 60_000);
  const logs = usePoll<LogsShape>("/api/system/logs", 20_000);
  const ev = usePoll<EvShape>("/api/system/events?limit=60", 15_000);
  const d = s.data;
  return (
    <div className="flex flex-col gap-2">
      <PageHead
        title={t("nav", "system")}
        sub={t("sys", "sub")}
        right={
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${d?.health.market === "LIVE" ? "breathe" : ""}`} style={{ background: stateColor(d?.health.market ?? "CONNECTING") }} aria-hidden />
            <StatusChip state={d?.health.market ?? "CONNECTING"} />
          </span>
        }
      />
      {s.status !== "OK" && (
        <TruthState status={s.status} failure={s.failure} onRetry={s.refresh} staleAgeMs={d ? s.stale_age_ms : null} />
      )}
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        <Panel title={t("sys", "engine")}>
          <Row k={t("sys", "booted")} v={d?.booted ? "yes" : "no"} color={d?.booted ? "var(--color-up)" : "var(--color-warn)"} />
          <Row k={t("sys", "uptime")} v={d ? fmtAge(d.uptime_ms) : "—"} />
          <Row k={t("sys", "catalogSymbols")} v={String(d?.catalog_symbols ?? 0)} />
          <Row k={t("sys", "liveBoard")} v={d ? `${d.live.live}/${d.live.total}` : "—"} />
          <Row k={t("sys", "statsAge")} v={d?.stats_age_ms !== null && d?.stats_age_ms !== undefined ? fmtAge(d.stats_age_ms) : "—"} />
          <Row k={t("sys", "reason")} v={d?.health.reason ?? t("sys", "none")} />
        </Panel>
        <Panel title={t("sys", "scheduler")}>
          <Row k={t("sys", "budget")} v={`${d?.scheduler.budget_per_min ?? 0} req/min`} />
          <Row k={t("sys", "configured")} v={`${d?.scheduler.configured_per_min ?? 0} req/min`} />
          <Row k={t("sys", "totalRequests")} v={String(d?.scheduler.total_requests ?? 0)} />
          <Row k={t("sys", "rate429")} v={String(d?.scheduler.total_429 ?? 0)} color={(d?.scheduler.total_429 ?? 0) > 0 ? "var(--color-down)" : "var(--color-up)"} />
          <Row k={t("sys", "paused")} v={d?.scheduler.paused ? t("sys", "pausedBackoff") : "no"} color={d?.scheduler.paused ? "var(--color-warn)" : "inherit"} />
          <Row k={t("sys", "candleQueue")} v={`${d?.candles.queueDepth ?? 0} ${t("sys", "waiting")} · ${d?.candles.fetchedTotal ?? 0} ${t("sys", "fetched")}`} />
        </Panel>
        <Panel title={t("sys", "riskPolicy")}>
          <Row k={t("sys", "equity")} v={cfg.data?.prefs["risk.equity"] ?? t("sys", "unset")} />
          <Row k={t("sys", "perTrade")} v={cfg.data?.prefs["risk.perTradePct"] ?? t("sys", "unset")} />
          <Row k={t("sys", "maxLeverage")} v={cfg.data?.prefs["risk.maxLeverage"] ?? t("sys", "unset")} />
          <Row k={t("sys", "enforcement")} v={t("sys", "hardGate")} color="var(--color-warn)" />
          <p className="mt-1 text-[9px] text-dim" dir="auto">{t("sys", "riskNote")}</p>
        </Panel>
        <Panel title={t("sys", "providers")}>
          {(d?.ai ?? []).map((p) => (
            <Row key={p.id} k={`ai:${p.id}`} v={p.online === true ? t("sys", "online") : p.configured ? (p.online === null ? t("sys", "probing") : t("sys", "offline")) : t("sys", "notConfigured")} color={p.online === true ? "var(--color-up)" : p.configured ? "var(--color-warn)" : "var(--color-dim)"} />
          ))}
          <Row k="telegram" v={d?.telegram.state ?? "—"} color={d?.telegram.state === "CONNECTED" ? "var(--color-up)" : "var(--color-dim)"} />
          {d?.telegram.dry_run && <Row k={t("sys", "telegramDryRun")} v={t("sys", "telegramDryRunOn")} color="var(--color-warn)" />}
          <Row k="news" v={d?.news.state ?? "—"} color={d?.news.state === "NOT_CONFIGURED" ? "var(--color-dim)" : "var(--color-up)"} />
          <Row k={t("sys", "storage")} v={d?.storage ?? "—"} color={d?.storage === "OK" ? "var(--color-up)" : "var(--color-down)"} />
        </Panel>
        <Panel title={t("sys", "stateErrors")}>
          <Row k={t("sys", "tttErrors")} v={String(d?.ttt_errors ?? 0)} color={(d?.ttt_errors ?? 0) > 0 ? "var(--color-down)" : "var(--color-up)"} />
          <div className="mt-1 max-h-[150px] space-y-0.5 overflow-y-auto">
            {logs.data?.errors.slice(-8).map((e, i) => (
              <div key={i} className="text-[9px] leading-snug text-dim" title={e.message}>
                <span style={{ color: "var(--color-down)" }}>{e.kind}</span> {e.endpoint} — {e.message.slice(0, 70)}
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-dim" dir="auto">{t("sys", "noSecrets")}</p>
        </Panel>
      </div>
      <div className="grid gap-2 xl:grid-cols-2">
        <Panel title={t("sys", "retention")}>
          <div className="max-h-[200px] overflow-y-auto">
            {logs.data?.retention_runs.slice(0, 20).map((r2) => (
              <div key={r2.id} className="flex justify-between gap-2 border-b border-dashed py-0.5 text-[10.5px]" style={{ borderColor: "var(--color-line)" }}>
                <span className="mono text-dim">{new Date(r2.ran_ms).toISOString().slice(0, 16)}</span>
                <span className="text-muted">{r2.table_name}</span>
                <span style={{ color: r2.ok ? "var(--color-up)" : "var(--color-down)" }}>{t("sys", "deleted")} {r2.deleted}</span>
              </div>
            ))}
            {!logs.data?.retention_runs.length && <div className="text-[10.5px] text-muted" dir="auto">{t("sys", "noRetentionRuns")}</div>}
          </div>
        </Panel>
        <Panel
          title={t("sys", "eventBus")}
          right={<span className="meta-strip"><span className="mono iso">{t("sys", "eventsCount").replace("{n}", String(ev.data?.events.length ?? 0))}</span></span>}
        >
          <div className="max-h-[220px] overflow-y-auto">
            <Timeline items={(ev.data?.events ?? []).slice(-40).reverse().map((e) => ({ at: e.ts, text: e.type }))} />
          </div>
        </Panel>
      </div>
      <Panel title={t("sys", "freshness")}>
        <p className="text-[10.5px] text-muted">
          {t("sys", "freshnessNote")}
        </p>
      </Panel>
    </div>
  );
}
