"use client";
/** System — observability surface (no secrets). TTT budget, lanes, coverage, AI/Telegram/News, retention. */
import { useLang } from "@/components/lang";
import { usePoll, fmtAge } from "@/components/hooks";
import { Badge, Panel, StatusChip } from "@/components/ui";

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

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return <div className="flex items-center justify-between gap-3 py-1 text-[11.5px]"><span className="text-muted">{k}</span><span className="mono" style={{ color }}>{v}</span></div>;
}

export default function SystemPage() {
  const { t } = useLang();
  const s = usePoll<StatusShape>("/api/system/status", 15_000);
  const logs = usePoll<LogsShape>("/api/system/logs", 20_000);
  const ev = usePoll<EvShape>("/api/system/events?limit=60", 15_000);
  const d = s.data;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">{t("nav", "system")}</h1>
        <StatusChip state={d?.health.market ?? "CONNECTING"} />
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="engine">
          <Row k="booted" v={d?.booted ? "yes" : "no"} color={d?.booted ? "#3fb68b" : "#d6a24a"} />
          <Row k="uptime" v={d ? fmtAge(d.uptime_ms) : "—"} />
          <Row k="catalog symbols" v={String(d?.catalog_symbols ?? 0)} />
          <Row k="live board" v={d ? `${d.live.live}/${d.live.total}` : "—"} />
          <Row k="stats age" v={d?.stats_age_ms !== null && d?.stats_age_ms !== undefined ? fmtAge(d.stats_age_ms) : "—"} />
          <Row k="reason" v={d?.health.reason ?? ""} />
        </Panel>
        <Panel title="TTT scheduler (rate budget)">
          <Row k="budget" v={`${d?.scheduler.budget_per_min ?? 0} req/min`} />
          <Row k="configured" v={`${d?.scheduler.configured_per_min ?? 0} req/min`} />
          <Row k="total requests" v={String(d?.scheduler.total_requests ?? 0)} />
          <Row k="429 count" v={String(d?.scheduler.total_429 ?? 0)} color={(d?.scheduler.total_429 ?? 0) > 0 ? "#d9605e" : "#3fb68b"} />
          <Row k="paused" v={d?.scheduler.paused ? "yes (backoff)" : "no"} color={d?.scheduler.paused ? "#d6a24a" : "inherit"} />
          <Row k="candle queue" v={`${d?.candles.queueDepth ?? 0} waiting · ${d?.candles.fetchedTotal ?? 0} fetched`} />
        </Panel>
        <Panel title="providers & channels">
          {(d?.ai ?? []).map((p) => (
            <Row key={p.id} k={`ai:${p.id}`} v={p.online === true ? "ONLINE" : p.configured ? (p.online === null ? "probing" : "OFFLINE") : "not configured"} color={p.online === true ? "#3fb68b" : p.configured ? "#d6a24a" : "#5d616b"} />
          ))}
          <Row k="telegram" v={d?.telegram.state ?? "—"} color={d?.telegram.state === "CONNECTED" ? "#3fb68b" : "#5d616b"} />
          {d?.telegram.dry_run && <Row k="telegram dry-run" v="ON (nothing sent)" color="#d6a24a" />}
          <Row k="news" v={d?.news.state ?? "—"} color={d?.news.state === "NOT_CONFIGURED" ? "#5d616b" : "#3fb68b"} />
          <Row k="storage" v={d?.storage ?? "—"} color={d?.storage === "OK" ? "#3fb68b" : "#d9605e"} />
        </Panel>
        <Panel title="state & errors">
          <Row k="ttt errors (window)" v={String(d?.ttt_errors ?? 0)} color={(d?.ttt_errors ?? 0) > 0 ? "#d9605e" : "#3fb68b"} />
          <div className="mt-1 max-h-[150px] space-y-0.5 overflow-y-auto">
            {logs.data?.errors.slice(-8).map((e, i) => (
              <div key={i} className="text-[9px] leading-snug text-dim" title={e.message}>
                <span style={{ color: "#d9605e" }}>{e.kind}</span> {e.endpoint} — {e.message.slice(0, 70)}
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-dim">status includes no secrets — credentials show as configured/not configured only.</p>
        </Panel>
      </div>
      <div className="grid gap-2 xl:grid-cols-2">
        <Panel title="retention audit runs (news 30d window)">
          <div className="max-h-[200px] overflow-y-auto">
            {logs.data?.retention_runs.slice(0, 20).map((r2) => (
              <div key={r2.id} className="flex justify-between gap-2 border-b border-dashed py-0.5 text-[10.5px]" style={{ borderColor: "var(--color-line)" }}>
                <span className="mono text-dim">{new Date(r2.ran_ms).toISOString().slice(0, 16)}</span>
                <span className="text-muted">{r2.table_name}</span>
                <span style={{ color: r2.ok ? "#3fb68b" : "#d9605e" }}>deleted {r2.deleted}</span>
              </div>
            ))}
            {!logs.data?.retention_runs.length && <div className="text-[10.5px] text-muted">no retention runs yet (first run ~45s after boot, then every 30 min)</div>}
          </div>
        </Panel>
        <Panel title="event bus (SSE tail)">
          <div className="max-h-[200px] space-y-0.5 overflow-y-auto font-mono text-[9.5px] text-muted">
            {ev.data?.events.slice(-40).map((e, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-dim">{new Date(e.ts).toLocaleTimeString()}</span>
                <span>{e.type}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="freshness thresholds (documented)">
        <p className="text-[10.5px] text-muted">
          LIVE = stats age &lt; 30s · STALE &lt; 2 min · DEGRADED &lt; 10 min · UNAVAILABLE beyond. A connected socket ≠ fresh data; each row above measures the last successful upstream sweep.
        </p>
      </Panel>
    </div>
  );
}
