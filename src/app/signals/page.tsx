"use client";
/** Signals — advisory lifecycle + manual journal (self-reported R). */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Badge, Empty, Panel, StatusChip } from "@/components/ui";

import { SIGNAL_STATES } from "@/lib/pipeline/signal-lifecycle";

interface DeliveryView {
  delivery_state?: string; attempts?: number | null; error?: string | null;
  sent_ms?: number | null; outbox_id?: number | null; link?: string | null;
  progress?: { photo_required: boolean; photo_sent: boolean; text_sent: boolean } | null;
}
interface SigItem {
  id: string; state: string; symbol: string; timeframe: string; direction: string;
  score: number; strategy_id: string; created_ms: number; updated_ms: number;
  delivery?: DeliveryView; opp_id?: string | null;
}
interface SigShape { ok: boolean; items: SigItem[] }
interface JItem { id: number; created_ms: number; symbol: string; direction: string; notes: string; r_multiple: number | null }
interface JShape { ok: boolean; items: JItem[] }

export default function SignalsPage() {
  const { t } = useLang();
  const { data, refresh, loading, error, age_ms } = usePoll<SigShape>("/api/signals?limit=100", 15000);
  const journal = usePoll<JShape>("/api/signals/journal", 10000);
  const [sym, setSym] = useState("BTCUSDT");
  const [dir, setDir] = useState<"long" | "short">("long");
  const [notes, setNotes] = useState("");
  const [r, setR] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const items = data?.items ?? [];

  const save = async () => {
    setSaved(null);
    try {
      const res = await fetch("/api/signals/journal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, direction: dir, notes, r_multiple: r === "" ? null : Number(r) }),
      });
      const j = await res.json() as { ok: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setNotes(""); setR(""); setSaved("saved"); journal.refresh(); refresh();
    } catch (e) { setSaved(`Not saved: ${e instanceof Error ? e.message : "network unavailable"}`); }
  };

  const del = async (id: number) => {
    try {
      const res = await fetch(`/api/signals/journal/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved("deleted"); journal.refresh();
    } catch (e) { setSaved(`Not deleted: ${e instanceof Error ? e.message : "network unavailable"}`); }
  };

  return (
    <div className="grid gap-2 xl:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-2">
        <h1 className="text-[15px] font-semibold">{t("nav", "signals")}</h1>
        <p className="-mt-1 text-[11px] text-muted">
          Lifecycle states: {SIGNAL_STATES.join(" · ")} · signal ≠ order · stale published signals are expired by the engine
        </p>
        {loading && !data && <p role="status">Loading advisory signals…</p>}
        {error && <p role="alert" className="text-down">Signals unavailable: {error}. {data ? "Showing last received state, not a current delivery confirmation." : "No signal state could be loaded."}</p>}
        {data && age_ms !== null && age_ms > 30_000 && <p role="status" className="text-muted">STALE — last successful signal refresh {Math.floor(age_ms / 1000)}s ago.</p>}
        {!loading && !error && data && items.length === 0 && <Empty text="No signals yet. Signals are only published after the strategy, admission and hard risk gates pass. Nothing is simulated." />}
        {items.map((s) => (
          <Panel key={s.id} title={`${s.symbol} · ${s.direction} @ ${s.timeframe}`} right={<StatusChip state={s.state} label={s.state} />}>
            <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <Badge color="#d4b874">score {s.score}</Badge>
              <Badge>{s.strategy_id}</Badge>
              <Badge color={s.delivery?.delivery_state === "SENT" ? "#3fb68b" : s.delivery?.delivery_state === "FAILED" || s.delivery?.delivery_state === "DEAD" ? "#d9605e" : undefined}>
                delivery {s.delivery?.delivery_state ?? "UNLINKED"}
              </Badge>
              <span className="text-dim">created {new Date(s.created_ms).toLocaleString()}</span>
            </div>
            <p className="mt-1 text-[10px] text-muted">
              <a className="underline" href={`/signals/${encodeURIComponent(s.id)}`}>Decision & lifecycle</a> · {" "}
              <a className="underline" href={`/api/signals/${encodeURIComponent(s.id)}`}>Signal provenance</a>
              {s.opp_id && <> · opportunity {s.opp_id}</>}
              {s.delivery?.outbox_id != null && <> · outbox #{s.delivery.outbox_id}</>}
              {s.delivery?.link === "legacy_payload_match" && <> · legacy payload link (historical lineage incomplete)</>}
              {s.delivery?.progress && <> · chart {s.delivery.progress.photo_required ? s.delivery.progress.photo_sent ? "accepted" : "pending" : "not required (legacy)"} · text {s.delivery.progress.text_sent ? "accepted" : "pending"}</>}
            </p>
            {s.delivery?.error && <p className="mt-1 text-[10.5px]" style={{ color: "#d9605e" }}>delivery: {s.delivery.error}</p>}
            <p className="mt-1.5 text-[9.5px] text-dim">Advisory only — AsA has no execution path. Delivery failure does not change the decision. The human decides on their venue.</p>
          </Panel>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Panel title="manual journal">
          <div className="flex flex-wrap gap-1.5">
            <input className="input w-[110px]" value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} aria-label="symbol" />
            <select className="input w-[90px]" value={dir} onChange={(e) => setDir(e.target.value as "long" | "short")}>
              <option value="long">long</option><option value="short">short</option>
            </select>
            <input className="input w-[80px]" placeholder="R mult." value={r} onChange={(e) => setR(e.target.value)} aria-label="R multiple (self-reported)" />
          </div>
          <textarea className="input mt-1.5 min-h-[70px]" placeholder="notes (what was the plan? what did the market do?)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="mt-1.5 flex items-center gap-2">
            <button className="btn-gold btn" onClick={() => void save()}>add entry</button>
            {saved && <span role="status" className="text-[10.5px]" style={{ color: saved === "saved" ? "#3fb68b" : "#d9605e" }}>{saved}</span>}
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">R multiple is self-reported. AsA never reads your venue account.</p>
        </Panel>
        <Panel title={`journal (${journal.data?.items.length ?? 0})`}>
          <ul className="max-h-[420px] space-y-1.5 overflow-y-auto">
            {journal.data?.items.map((j) => (
              <li key={j.id} className="panel-2 px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{j.symbol} <span style={{ color: j.direction === "long" ? "#3fb68b" : "#d9605e" }}>{j.direction}</span></span>
                  <span className="flex items-center gap-1.5">
                    {j.r_multiple !== null && <Badge color={(j.r_multiple ?? 0) >= 0 ? "#3fb68b" : "#d9605e"}>R {j.r_multiple}</Badge>}
                    <button className="focus-ring rounded px-1 text-[10px] text-dim hover:text-down" onClick={() => void del(j.id)} aria-label="delete">✕</button>
                  </span>
                </div>
                {j.notes && <p className="mt-0.5 text-muted">{j.notes}</p>}
                <p className="mt-0.5 text-[9px] text-dim">{new Date(j.created_ms).toLocaleString()}</p>
              </li>
            ))}
            {journal.data?.items.length === 0 && <li className="text-muted">empty journal</li>}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
