"use client";
/** Settings — explicit risk inputs and provider mode. Missing values stay unconfigured. */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Panel } from "@/components/ui";
import { riskPolicySaveSelection, riskPolicySelectValue } from "@/lib/risk/selection-ui";

interface RiskPolicyOption {
  policy_id: string;
  canonical_name: string;
  source_status: string;
  conflict_group_id: string | null;
  eligibility: { selectable: boolean; reasons: string[]; source_completeness: Record<string, string> };
}
interface ConfigShape {
  ok: boolean;
  env: Record<string, unknown>;
  prefs: Record<string, string>;
  risk_policy?: { policy_id: string; selection_status: string; selection_reason: string };
  risk_policy_options?: RiskPolicyOption[];
  note?: string;
}

export default function SettingsPage() {
  const { lang, setLang, t } = useLang();
  const cfg = usePoll<ConfigShape>("/api/system/config", 20000);
  const [equityDraft, setEquityDraft] = useState<string | null>(null);
  const [perTradeDraft, setPerTradeDraft] = useState<string | null>(null);
  const [maxLevDraft, setMaxLevDraft] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const riskEnv = cfg.data?.env.risk as Record<string, unknown> | undefined;
  const aiEnv = cfg.data?.env.ai as Record<string, unknown> | undefined;
  const prefs = cfg.data?.prefs ?? {};
  const equity = equityDraft ?? prefs["risk.equity"]?.replace("UNCONFIGURED", "") ?? (riskEnv?.equity === null ? "" : String(riskEnv?.equity ?? ""));
  const perTrade = perTradeDraft ?? prefs["risk.perTradePct"]?.replace("UNCONFIGURED", "") ?? (riskEnv?.per_trade_pct === null ? "" : String(riskEnv?.per_trade_pct ?? ""));
  const maxLev = maxLevDraft ?? prefs["risk.maxLeverage"]?.replace("UNCONFIGURED", "") ?? (riskEnv?.max_leverage === null ? "" : String(riskEnv?.max_leverage ?? ""));
  const selectedPolicy = riskPolicySelectValue(
    policyDraft,
    prefs["risk.policyId"],
    cfg.data?.risk_policy?.policy_id,
  );
  const providerValue = provider ?? prefs["ai.provider"] ?? String(aiEnv?.default_provider ?? "auto");

  const save = async (section: "risk" | "ai", body: Record<string, unknown>) => {
    setMsg(null);
    const res = await fetch("/api/system/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section, ...body }),
    });
    const j = (await res.json()) as { ok: boolean; error?: string };
    setMsg(j.ok ? `saved (${section}) — applied to the next scan` : j.error ?? "failed");
    cfg.refresh();
  };

  const env = cfg.data?.env;
  const ttt = env?.ttt as Record<string, unknown> | undefined;
  const ai = env?.ai as Record<string, unknown> | undefined;

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[15px] font-semibold">{t("nav", "settings")}</h1>
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="language / زبان">
          <div className="flex items-center gap-2">
            <button className={`btn ${lang === "en" ? "btn-active" : ""}`} onClick={() => setLang("en")}>English (LTR)</button>
            <button className={`btn ${lang === "fa" ? "btn-active" : ""}`} onClick={() => setLang("fa")}>فارسی (RTL)</button>
          </div>
          <p className="mt-2 text-[10px] text-dim">Language switches instantly; symbols are never translated. Numbers and dates follow the same layout; Persian digits render as-is from data (en digits in market tables).</p>
        </Panel>
        <Panel title="explicit risk configuration">
          <div className="grid grid-cols-3 gap-1.5">
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">equity (account currency)</span><input className="input" type="number" placeholder="unconfigured" value={equity} onChange={(e) => setEquityDraft(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">risk/trade %</span><input className="input" type="number" step="0.1" placeholder="unconfigured" value={perTrade} onChange={(e) => setPerTradeDraft(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">max leverage</span><input className="input" type="number" placeholder="unconfigured" value={maxLev} onChange={(e) => setMaxLevDraft(e.target.value)} /></label>
          </div>
          <label className="mt-2 flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">source-backed policy selection</span>
            <select className="input" value={selectedPolicy} onChange={(e) => setPolicyDraft(e.target.value)}>
              <option value="UNSELECTED">UNSELECTED — no production risk policy</option>
              {(cfg.data?.risk_policy_options ?? []).map((p) => {
                const completeness = Object.entries(p.eligibility.source_completeness).map(([file, state]) => `${file}:${state}`).join(",");
                return <option key={p.policy_id} value={p.policy_id} disabled={!p.eligibility.selectable}>{p.canonical_name} · {p.source_status}{completeness ? ` · ${completeness}` : ""}{p.conflict_group_id ? ` · ${p.conflict_group_id}` : ""}</option>;
              })}
            </select>
          </label>
          <button className="btn-gold btn mt-2" onClick={() => void save("risk", {
            equity: equity.trim() === "" ? null : Number(equity),
            perTradePct: perTrade.trim() === "" ? null : Number(perTrade),
            maxLeverage: maxLev.trim() === "" ? null : Number(maxLev),
            ...riskPolicySaveSelection(policyDraft, selectedPolicy),
          })}>save risk configuration</button>
          <p className="mt-1.5 text-[9.5px] text-dim">No numeric defaults are applied. Conflicting, inferred, claimed, unreferenced, or incomplete-source policies stay blocked. Account inputs are operator configuration, not source rules.</p>
          <div className="mt-1 max-h-28 overflow-auto text-[9px] text-dim">
            {(cfg.data?.risk_policy_options ?? []).filter((policy) => !policy.eligibility.selectable).map((policy) => <p key={policy.policy_id}><span className="mono">{policy.policy_id}</span>: {policy.eligibility.reasons.join("; ")}</p>)}
          </div>
          {cfg.data?.risk_policy && <p className="mt-1 text-[9.5px] text-dim">active selection: {cfg.data.risk_policy.policy_id} · {cfg.data.risk_policy.selection_status} — {cfg.data.risk_policy.selection_reason}</p>}
        </Panel>
        <Panel title="AI provider mode">
          <select className="input" value={providerValue} onChange={(e) => setProvider(e.target.value)}>
            <option value="auto">auto — configured providers, otherwise heuristic</option>
            <option value="heuristic">heuristic only (deterministic)</option>
            <option value="ollama">ollama (local)</option>
            <option value="openai">openai-compatible</option>
          </select>
          <button className="btn-gold btn mt-2" onClick={() => void save("ai", { provider: providerValue })}>save AI mode</button>
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
      {msg && <div className="text-[11.5px]" style={{ color: msg.startsWith("saved") ? "#3fb68b" : "#d9605e" }}>{msg}</div>}
    </div>
  );
}
