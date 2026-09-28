"use client";
/** Signals — advisory lifecycle + manual journal (self-reported R). */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll, postJson } from "@/components/hooks";
import { Badge, Empty, Panel, StatusChip } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";
import { useToast } from "@/components/toast";

import { SIGNAL_STATES as LIFECYCLE } from "@/lib/domain/signal-states";

interface DeliveryView {
  delivery_state?: string; attempts?: number | null; error?: string | null;
  sent_ms?: number | null; outbox_id?: number | null;
  link?: string | null;
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
  const toast = useToast();
  const poll = usePoll<SigShape>("/api/signals?limit=100", 15000);
  const { data, refresh } = poll;
  const ready = poll.status === "OK";
  const journal = usePoll<JShape>("/api/signals/journal", 10000);
  const [sym, setSym] = useState("BTCUSDT");
  const [dir, setDir] = useState<"long" | "short">("long");
  const [notes, setNotes] = useState("");
  const [r, setR] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const items = ready ? data?.items ?? [] : [];

  const save = async () => {
    setSaved(null);
    setSaving(true);
    // postJson attaches the operator token when present; every server verdict
    // (200 ok:false, 401, 503 fail-closed, offline) surfaces verbatim.
    const j = await postJson<{ ok: boolean; error?: string }>("/api/signals/journal", {
      symbol: sym, direction: dir, notes, r_multiple: r === "" ? null : Number(r),
    });
    setSaving(false);
    if (j.ok) {
      setNotes(""); setR(""); setSaved("saved"); journal.refresh(); refresh();
      toast.push({ title: "journal entry stored", body: `${sym} · ${dir} — the server accepted it; R stays self-reported`, tone: "success" });
    } else {
      const msg = j.error ?? `failed (HTTP ${j.status})`;
      setSaved(msg);
      toast.push({ title: "journal entry not stored", body: msg, tone: "error", action: { label: "retry save", run: () => void save() } });
    }
  };

  const del = async (id: number) => {
    const j = await postJson(`/api/signals/journal/${id}`, undefined, "DELETE");
    if (!j.ok) setSaved(`delete failed: ${j.error}`);
    journal.refresh();
  };

  return (
    <div className="grid gap-2 xl:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-2">
        <PageHead
          title={t("nav", "signals")}
          sub={`Lifecycle: ${LIFECYCLE.join(" → ")} · signal ≠ order · stale published signals are expired by the engine`}
          right={ready ? <span className="meta-strip"><span className="mono iso">{items.length} records</span></span> : undefined}
        />
        {!ready && <TruthState status={poll.status} failure={poll.failure} onRetry={refresh} staleAgeMs={data ? poll.stale_age_ms : null} />}
        {ready && items.length === 0 && <Empty text="EMPTY — the backend answered and no signals are stored. Signals require every gate, including current complete risk and empirical strategy promotion. Nothing is simulated." />}
        {items.map((s, i) => (
          <div key={s.id} className="rise" style={{ ["--i" as never]: i % 8 }}>
          <Panel title={`${s.symbol} · ${s.direction} @ ${s.timeframe}`} right={<StatusChip state={s.state} label={s.state} />}>
            <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <Badge color="var(--color-gold)">score {s.score}</Badge>
              <Badge>{s.strategy_id}</Badge>
              <Badge color={s.delivery?.delivery_state === "SENT" ? "var(--color-up)" : s.delivery?.delivery_state === "FAILED" || s.delivery?.delivery_state === "DEAD" ? "var(--color-down)" : undefined}>
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
            {s.delivery?.error && <p className="mt-1 text-[10.5px]" style={{ color: "var(--color-down)" }}>delivery: {s.delivery.error}</p>}
            <p className="mt-1.5 text-[9.5px] text-dim">Advisory only — AsA has no execution path. Delivery failure does not change the decision. The human decides on their venue.</p>
          </Panel>
          </div>
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
            <button className="btn-gold btn" disabled={saving} onClick={() => void save()}>{saving ? "sending…" : "add entry"}</button>
            {saved && <span role="status" className="text-[10.5px]" style={{ color: saved === "saved" ? "var(--color-up)" : "var(--color-down)" }}>{saved}</span>}
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">R multiple is self-reported. AsA never reads your venue account. In production, mutations require the operator token (Settings).</p>
        </Panel>
        <Panel title={`journal (${journal.data?.items.length ?? 0})`}>
          <ul className="max-h-[420px] space-y-1.5 overflow-y-auto">
            {journal.data?.items.map((j) => (
              <li key={j.id} className="panel-2 px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{j.symbol} <span style={{ color: j.direction === "long" ? "var(--color-up)" : "var(--color-down)" }}>{j.direction}</span></span>
                  <span className="flex items-center gap-1.5">
                    {j.r_multiple !== null && <Badge color={(j.r_multiple ?? 0) >= 0 ? "var(--color-up)" : "var(--color-down)"}>R {j.r_multiple}</Badge>}
                    <button className="focus-ring rounded px-1 text-[10px] text-dim hover:text-down" onClick={() => void del(j.id)} aria-label="delete">✕</button>
                  </span>
                </div>
                {j.notes && <p className="mt-0.5 text-muted">{j.notes}</p>}
                <p className="mt-0.5 text-[9px] text-dim">{new Date(j.created_ms).toLocaleString()}</p>
              </li>
            ))}
            {journal.status === "OK" && journal.data?.items.length === 0 && <li className="text-muted">EMPTY — the backend answered: journal holds no entries</li>}
            {journal.status !== "OK" && <li className="text-muted">{journal.status === "LOADING" ? "loading journal…" : journal.failure?.message ?? "journal unavailable"}</li>}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
