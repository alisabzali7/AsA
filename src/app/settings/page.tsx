"use client";
/** Settings — language, risk prefs (DB, applied live), provider mode. Masked env config. */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Panel } from "@/components/ui";

interface ConfigShape { ok: boolean; env: Record<string, unknown>; prefs: Record<string, string>; note?: string }

export default function SettingsPage() {
  const { lang, setLang, t } = useLang();
  const cfg = usePoll<ConfigShape>("/api/system/config", 20000);
  const [equityDraft, setEquity] = useState<string | null>(null);
  const [perTradeDraft, setPerTrade] = useState<string | null>(null);
  const [maxLevDraft, setMaxLev] = useState<string | null>(null);
  const [provider, setProvider] = useState("auto");
  const [msg, setMsg] = useState<string | null>(null);
  const riskEnv = cfg.data?.env?.risk as Record<string,unknown> | undefined;
  const equity = equityDraft ?? cfg.data?.prefs["risk.equity"] ?? String(riskEnv?.equity ?? 10000);
  const perTrade = perTradeDraft ?? cfg.data?.prefs["risk.perTradePct"] ?? String(riskEnv?.per_trade_pct ?? 1);
  const maxLev = maxLevDraft ?? cfg.data?.prefs["risk.maxLeverage"] ?? String(riskEnv?.max_leverage ?? 5);

  const save = async (section: "risk" | "ai", body: Record<string, unknown>) => {
    setMsg(null);
    try {
      const res = await fetch("/api/system/config", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({section,...body}),
      });
      const j = await res.json() as {ok:boolean;error?:string};
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setMsg(`saved (${section}) — applied to the next scan`); cfg.refresh();
    } catch(e) {setMsg(`Not saved: ${e instanceof Error ? e.message : "network unavailable"}`);}
  };

  const env = cfg.data?.env as Record<string, unknown> | undefined;
  const ttt = env?.ttt as Record<string, unknown> | undefined;
  const ai = env?.ai as Record<string, unknown> | undefined;

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[15px] font-semibold">{t("nav", "settings")}</h1>
      {cfg.error && <p role="alert" className="text-down">Configuration unavailable: {cfg.error}</p>}
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="language / زبان">
          <div className="flex items-center gap-2">
            <button className={`btn ${lang === "en" ? "btn-active" : ""}`} onClick={() => setLang("en")}>English (LTR)</button>
            <button className={`btn ${lang === "fa" ? "btn-active" : ""}`} onClick={() => setLang("fa")}>فارسی (RTL)</button>
          </div>
          <p className="mt-2 text-[10px] text-dim">Language switches instantly; symbols are never translated. Numbers and dates follow the same layout; Persian digits render as-is from data (en digits in market tables).</p>
        </Panel>
        <Panel title="risk defaults (deterministic engine)">
          <div className="grid grid-cols-3 gap-1.5">
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">equity (USD)</span><input className="input" type="number" value={equity} onChange={(e) => setEquity(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">risk/trade %</span><input className="input" type="number" step="0.1" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">max leverage</span><input className="input" type="number" value={maxLev} onChange={(e) => setMaxLev(e.target.value)} /></label>
          </div>
          <button className="btn-gold btn mt-2" disabled={!cfg.data || !!cfg.error} onClick={() => void save("risk", { equity: Number(equity), perTradePct: Number(perTrade), maxLeverage: Number(maxLev) })}>save risk</button>
          <p className="mt-1.5 text-[9.5px] text-dim">Saved equity and fallback sizing are server-owned. The selected risk policy takes precedence over per-trade risk and leverage defaults. These are advisory suggestions; you size and execute.</p>
        </Panel>
        <Panel title="AI mode">
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="auto">auto — local then cloud, else heuristic</option>
            <option value="heuristic">heuristic only (deterministic)</option>
            <option value="ollama">ollama (local)</option>
            <option value="openai">openai-compatible</option>
          </select>
          <button className="btn-gold btn mt-2" onClick={() => void save("ai", { provider })}>save ai mode</button>
          <p className="mt-1.5 text-[9.5px] text-dim">Provider endpoints and keys are read from server environment variables only — see .env.example; nothing is entered in this UI and nothing secret reaches the browser.</p>
        </Panel>
        <Panel title="masked environment (server)">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px]">
            <span className="text-muted">TTT base</span><span className="mono text-right">{String(ttt?.base ?? "—")}</span>
            <span className="text-muted">TTT key</span><span className="mono text-right">{String(ttt?.key ?? "—")}</span>
            <span className="text-muted">TTT rate/min</span><span className="mono text-right">{String(ttt?.rate_per_min ?? "—")}</span>
            <span className="text-muted">ollama</span><span className="mono text-right">{String(ai?.ollama ?? "—")}</span>
            <span className="text-muted">openai</span><span className="mono text-right">{String(ai?.openai ?? "—")}</span>
            <span className="text-muted">telegram</span><span className="mono text-right">{String(env?.telegram ?? "—")}</span>
            <span className="text-muted">news rss</span><span className="mono text-right">{String((env?.news as Record<string, unknown>)?.rss ?? "—")}</span>
            <span className="text-muted">db path</span><span className="mono text-right">{String(env?.db_path ?? "—")}</span>
            <span className="text-muted">api token</span><span className="mono text-right">{String(env?.api_token ?? "—")}</span>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">{cfg.data?.note ?? "secrets never leave the server — masked as CONFIGURED/NOT CONFIGURED"}</p>
        </Panel>
      </div>
      {msg && <div role="status" className="text-[11.5px]" style={{ color: msg.startsWith("saved") ? "#3fb68b" : "#d9605e" }}>{msg}</div>}
    </div>
  );
}
