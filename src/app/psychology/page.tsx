"use client";
/** Psychology — explainable engine: measured facts, labeled proxies, honest unavailable. */
import { useLang } from "@/components/lang";
import { usePoll, stateColor, formatPrice } from "@/components/hooks";
import { Badge, Empty, Panel, StatusChip } from "@/components/ui";
import { useState } from "react";

interface Section { key: string; label: string; state: string; verdict: string; value?: number | string | null; evidence: string[]; reason?: string }
interface PsychShape { ok: boolean; symbol: string; bias: string; bias_reason: string; sections: Section[]; universe_funding: { measured: number; total: number; mean: number | null; max_abs: number | null } }

const VERDICT_COLOR: Record<string, string> = { MEASURED: "#3fb68b", DERIVED: "#d6a24a", PROXY: "#d6a24a", UNVERIFIED: "#8b8f99", UNAVAILABLE: "#5d616b" };

export default function PsychologyPage() {
  const { t } = useLang();
  const [symbol, setSymbol] = useState("BTCUSDT");
  const p = usePoll<PsychShape>(`/api/psychology/summary?symbol=${symbol}`, 10000);
  const d = p.data;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-[15px] font-semibold">{t("nav", "psychology")}</h1>
          <p className="text-[11px] text-muted">A real engine with evidence, contradictions and missing evidence — null is never shown as zero.</p>
        </div>
        <select className="input w-[130px]" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "1000PEPEUSDT", "DOGEUSDT"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="grid gap-2 lg:grid-cols-[1fr_300px]">
        <div className="grid gap-2 sm:grid-cols-2">
          {d?.sections.map((s) => (
            <Panel key={s.key} title={s.label} right={<Badge color={VERDICT_COLOR[s.verdict] ?? "#8b8f99"}>{s.verdict}</Badge>}>
              <div className="mb-1 flex items-center gap-2">
                <StatusChip state={s.state as never} />
                {s.value !== null && s.value !== undefined && <span className="mono text-[13px]">{typeof s.value === "number" ? (Math.abs(s.value) > 10 ? s.value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : s.value) : s.value}</span>}
              </div>
              {s.reason && <p className="text-[10.5px] leading-relaxed" style={{ color: "#d6a24a" }}>reason: {s.reason}</p>}
              {s.evidence.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10.5px] text-muted">
                  {s.evidence.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </Panel>
          ))}
          {!d && <Empty text="loading psychology…" />}
        </div>
        <div className="flex flex-col gap-2">
          <Panel title="bias">
            <div className="text-[13px] font-semibold" style={{ color: "#d4b874" }}>{d?.bias ?? "…"} (never asserted without evidence)</div>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">{d?.bias_reason}</p>
          </Panel>
          <Panel title="universe funding (stats sweep)">
            {d && (
              <ul className="space-y-1 text-[11px]">
                <li className="flex justify-between"><span className="text-muted">measured</span><span className="mono">{d.universe_funding.measured}/{d.universe_funding.total}</span></li>
                <li className="flex justify-between"><span className="text-muted">mean</span><span className="mono">{d.universe_funding.mean === null ? "—" : `${(d.universe_funding.mean * 100).toFixed(4)}%`}</span></li>
                <li className="flex justify-between"><span className="text-muted">max |rate|</span><span className="mono">{d.universe_funding.max_abs === null ? "—" : `${(d.universe_funding.max_abs * 100).toFixed(4)}%`}</span></li>
              </ul>
            )}
          </Panel>
          <Panel title="semantics">
            <ul className="space-y-1 text-[10px] leading-relaxed text-muted">
              <li>MEASURED = TTT supplied the value now.</li>
              <li>DERIVED = computed by AsA from measured inputs (labeled).</li>
              <li>PROXY/UNVERIFIED = semantics not established — no conclusions drawn.</li>
              <li>UNAVAILABLE = no verified public source (liquidations, L/S, CVD).</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
