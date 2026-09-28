"use client";
/** Settings — language, theme, risk prefs (DB, applied live), provider mode, operator
 *  token, masked env config, cinematic intro replay, and PWA installation. Form values are HYDRATED FROM THE SERVER — the
 *  UI never presents invented defaults as if they were the active settings. */
import { useState, useSyncExternalStore } from "react";
import { useLang } from "@/components/lang";
import { usePoll, postJson, subscribeAsaToken, getAsaTokenSnapshot, getAsaTokenServerSnapshot, setAsaToken } from "@/components/hooks";
import { Panel, SectionHeader } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";
import { useToast } from "@/components/toast";
import { densityPref, motionPref, railPref, themePref } from "@/components/selection";
import { usePwaInstall } from "@/components/pwa";
import { IconSparkles, IconSun, IconMoon, IconZap } from "@/components/icons";
import { riskPolicySaveSelection, riskPolicySelectValue } from "@/components/risk-policy-selection";

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

function displayedRiskValue(draft: string | null, preference: string | undefined, environmentValue: unknown): string {
  if (draft !== null) return draft;
  if (preference !== undefined) return preference === "UNCONFIGURED" ? "" : preference;
  return environmentValue === null || environmentValue === undefined ? "" : String(environmentValue);
}

export default function SettingsPage() {
  const { lang, setLang, t } = useLang();
  const toast = useToast();
  const [theme, setTheme] = themePref.use();
  const [density, setDensity] = densityPref.use();
  const [motion, setMotion] = motionPref.use();
  const [rail, setRail] = railPref.use();
  const { isInstallable, isStandalone, triggerInstall } = usePwaInstall();

  const cfg = usePoll<ConfigShape>("/api/system/config", 20000);
  const prefs = cfg.data?.prefs ?? {};
  // Drafts are edits only. The displayed server/environment value is read
  // separately, so an empty field never disguises an implicit numeric default.
  const [equityDraft, setEquityDraft] = useState<string | null>(null);
  const [perTradeDraft, setPerTradeDraft] = useState<string | null>(null);
  const [maxLevDraft, setMaxLevDraft] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<string | null>(null);
  const [providerDraft, setProviderDraft] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  // the stored token lives in an external store (localStorage) — subscribed
  // via useSyncExternalStore, so no effect-driven hydration and no hydration
  // mismatch: the server snapshot is always "unknown", revealed after mount.
  const savedToken = useSyncExternalStore(subscribeAsaToken, getAsaTokenSnapshot, getAsaTokenServerSnapshot);

  const env = cfg.data?.env as Record<string, unknown> | undefined;
  const riskEnv = env?.risk as Record<string, unknown> | undefined;
  const ttt = env?.ttt as Record<string, unknown> | undefined;
  const ai = env?.ai as Record<string, unknown> | undefined;
  const news = env?.news as Record<string, unknown> | undefined;
  const equity = displayedRiskValue(equityDraft, prefs["risk.equity"], riskEnv?.equity);
  const perTrade = displayedRiskValue(perTradeDraft, prefs["risk.perTradePct"], riskEnv?.per_trade_pct);
  const maxLev = displayedRiskValue(maxLevDraft, prefs["risk.maxLeverage"], riskEnv?.max_leverage);
  const selectedPolicy = riskPolicySelectValue(policyDraft, prefs["risk.policyId"], cfg.data?.risk_policy?.policy_id);
  const providerValue = providerDraft ?? prefs["ai.provider"] ?? String(ai?.default_provider ?? "auto");

  const save = async (section: "risk" | "ai", body: Record<string, unknown>) => {
    setMsg(null);
    const result = await postJson<{ ok: boolean; error?: string }>("/api/system/config", { section, ...body });
    if (result.ok) {
      const message = `saved (${section}) — acknowledged by the server`;
      setMsg(message);
      toast.push({ title: `settings saved (${section})`, body: "the server acknowledged the update", tone: "success" });
      cfg.refresh();
      return;
    }
    const message = result.error ?? `HTTP ${result.status}`;
    setMsg(`${message}${result.status === 503 ? " (production is fail-closed until the operator token below is set)" : ""}`);
    toast.push({ title: `settings NOT saved (${section})`, body: message, tone: "error" });
    cfg.refresh();
  };

  const saveRisk = () => {
    const boundedInputs = [["equity", equity, 1, 1e9], ["per-trade risk", perTrade, 0.1, 50], ["maximum leverage", maxLev, 1, 50]] as const;
    for (const [label, value, minimum, maximum] of boundedInputs) {
      if (value.trim() === "") continue;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
        const message = `${label} must be a finite number in the range ${minimum}..${maximum}; no settings were changed`;
        setMsg(message);
        toast.push({ title: "risk settings not saved", body: message, tone: "error" });
        return;
      }
    }
    void save("risk", {
      equity: equity.trim() === "" ? null : Number(equity),
      perTradePct: perTrade.trim() === "" ? null : Number(perTrade),
      maxLeverage: maxLev.trim() === "" ? null : Number(maxLev),
      ...riskPolicySaveSelection(policyDraft, selectedPolicy),
    });
  };

  const replayIntro = () => {
    try {
      sessionStorage.removeItem("asa_intro_seen");
      window.location.href = "/";
    } catch {
      window.location.href = "/";
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <PageHead
        title={t("nav", "settings")}
        sub="server-owned settings below are read from and written to the AsA database; device presentation (theme, density, motion, rail) belongs to this browser only and never pretends to sync"
      />
      {cfg.status !== "OK" && (
        <TruthState status={cfg.status} failure={cfg.failure} onRetry={cfg.refresh} staleAgeMs={cfg.data ? cfg.stale_age_ms : null} />
      )}

      <SectionHeader label="device presentation & experience — stored in this browser only" />
      <div className="rise grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Panel title="theme / ظاهر">
          <div className="flex gap-1.5">
            <button
              className={`btn flex items-center gap-1.5 ${theme === "dark" ? "btn-active" : ""}`}
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
            >
              <IconMoon size={13} />
              <span>dark</span>
            </button>
            <button
              className={`btn flex items-center gap-1.5 ${theme === "light" ? "btn-active" : ""}`}
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
            >
              <IconSun size={13} />
              <span>light</span>
            </button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">
            Restrained Obsidian & Gold dark palette or Clean high-contrast daylight theme with zero flash.
          </p>
        </Panel>

        <Panel title="density / تراکم">
          <div className="flex gap-1.5">
            <button
              className={`btn ${density === "comfortable" ? "btn-active" : ""}`}
              onClick={() => setDensity("comfortable")}
              aria-pressed={density === "comfortable"}
            >
              comfortable
            </button>
            <button
              className={`btn ${density === "compact" ? "btn-active" : ""}`}
              onClick={() => setDensity("compact")}
              aria-pressed={density === "compact"}
            >
              compact
            </button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">
            Row rhythm across every table and panel; readability never changes.
          </p>
        </Panel>

        <Panel title="motion / انیمیشن">
          <div className="flex gap-1.5">
            <button
              className={`btn ${motion === "full" ? "btn-active" : ""}`}
              onClick={() => setMotion("full")}
              aria-pressed={motion === "full"}
            >
              full
            </button>
            <button
              className={`btn ${motion === "reduced" ? "btn-active" : ""}`}
              onClick={() => setMotion("reduced")}
              aria-pressed={motion === "reduced"}
            >
              reduced
            </button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">
            Reduced also follows the OS preference automatically; state feedback stays visible.
          </p>
        </Panel>

        <Panel title="navigation rail">
          <div className="flex gap-1.5">
            <button
              className={`btn ${rail === "expanded" ? "btn-active" : ""}`}
              onClick={() => setRail("expanded")}
              aria-pressed={rail === "expanded"}
            >
              expanded
            </button>
            <button
              className={`btn ${rail === "compact" ? "btn-active" : ""}`}
              onClick={() => setRail("compact")}
              aria-pressed={rail === "compact"}
            >
              icon rail
            </button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">
            Desktop sidebar width — the mobile bottom bar always stays reachable.
          </p>
        </Panel>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="cinematic entry / انیمیشن شروع">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold text-text">
                {lang === "fa" ? "انیمیشن سه بعدی اسکناس ۱۰۰ دلاری" : "3D $100 Bill Cinematic Intro"}
              </p>
              <p className="text-[10px] text-dim">
                {lang === "fa"
                  ? "اجرای مجدد خوش‌آمدگویی سه‌بعدی و پیام «سلام علی، به کارخانه پول‌سازی خودت خوش اومدی»"
                  : "Replay the interactive 3D banknote tearing experience and Ali welcome reveal on the home screen."}
              </p>
            </div>
            <button
              onClick={replayIntro}
              className="focus-ring btn btn-gold shrink-0 text-xs font-bold"
            >
              <IconSparkles size={13} />
              <span>{lang === "fa" ? "پخش مجدد" : "Replay Intro"}</span>
            </button>
          </div>
        </Panel>

        <Panel title="PWA / نصب اپلیکیشن">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold text-text">
                {isStandalone
                  ? (lang === "fa" ? "اپلیکیشن AsA نصب شده است" : "AsA Terminal is installed as PWA")
                  : (lang === "fa" ? "نصب به عنوان اپلیکیشن وب پیشرو (PWA)" : "Progressive Web App")}
              </p>
              <p className="text-[10px] text-dim">
                {isStandalone
                  ? (lang === "fa" ? "درحال اجرا در حالت مستقل (Standalone Mode)" : "Running in Standalone Display Mode")
                  : (lang === "fa" ? "نصب روی صفحه اصلی گوشی یا دسکتاپ با سرعت و دسترسی بدون حاشیه" : "Install on homescreen for instantaneous full-bleed execution")}
              </p>
            </div>
            {isInstallable && !isStandalone && (
              <button
                onClick={() => void triggerInstall()}
                className="focus-ring btn btn-gold shrink-0 text-xs font-bold"
              >
                <IconZap size={13} />
                <span>{lang === "fa" ? "نصب" : "Install PWA"}</span>
              </button>
            )}
          </div>
        </Panel>
      </div>

      <SectionHeader label="server-owned configuration" />
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="language / زبان">
          <div className="flex items-center gap-2">
            <button className={`btn ${lang === "en" ? "btn-active" : ""}`} onClick={() => setLang("en")}>English (LTR)</button>
            <button className={`btn ${lang === "fa" ? "btn-active" : ""}`} onClick={() => setLang("fa")}>فارسی (RTL)</button>
          </div>
          <p className="mt-2 text-[10px] text-dim">Language switches instantly; symbols are never translated. Persian and English get the same information hierarchy — nothing is hidden in either mode.</p>
        </Panel>
        <Panel title="explicit risk configuration">
          <div className="grid grid-cols-3 gap-1.5">
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">equity (account currency)</span><input className="input" type="number" min="1" max="1000000000" placeholder="unconfigured" value={equity} onChange={(event) => setEquityDraft(event.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">risk/trade %</span><input className="input" type="number" min="0.1" max="50" step="0.1" placeholder="unconfigured" value={perTrade} onChange={(event) => setPerTradeDraft(event.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">max leverage</span><input className="input" type="number" min="1" max="50" placeholder="unconfigured" value={maxLev} onChange={(event) => setMaxLevDraft(event.target.value)} /></label>
          </div>
          <label className="mt-2 flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">source-backed policy selection</span>
            <select className="input" value={selectedPolicy} onChange={(event) => setPolicyDraft(event.target.value)}>
              <option value="UNSELECTED">UNSELECTED — no production risk policy</option>
              {(cfg.data?.risk_policy_options ?? []).map((policy) => {
                const completeness = Object.entries(policy.eligibility.source_completeness).map(([file, state]) => `${file}:${state}`).join(", ");
                return <option key={policy.policy_id} value={policy.policy_id} disabled={!policy.eligibility.selectable}>{policy.canonical_name} · {policy.source_status}{completeness ? ` · ${completeness}` : ""}{policy.conflict_group_id ? ` · ${policy.conflict_group_id}` : ""}</option>;
              })}
            </select>
          </label>
          <button className="btn-gold btn mt-2" onClick={saveRisk}>save risk configuration</button>
          <p className="mt-1.5 text-[9.5px] text-dim">No numeric defaults are substituted. Conflicting, inferred, claimed, unreferenced, or incomplete-source policies stay blocked. Account inputs are operator configuration, not source rules; blank values explicitly clear the saved preference.</p>
          <div className="mt-1 max-h-28 overflow-auto text-[9px] text-dim">
            {(cfg.data?.risk_policy_options ?? []).filter((policy) => !policy.eligibility.selectable).map((policy) => <p key={policy.policy_id}><span className="mono">{policy.policy_id}</span>: {policy.eligibility.reasons.join("; ")}</p>)}
          </div>
          {cfg.data?.risk_policy && <p className="mt-1 text-[9.5px] text-dim">active selection: {cfg.data.risk_policy.policy_id} · {cfg.data.risk_policy.selection_status} — {cfg.data.risk_policy.selection_reason}</p>}
        </Panel>
        <Panel title="AI mode">
          <select className="input" value={providerValue} onChange={(e) => setProviderDraft(e.target.value)} aria-label="AI provider mode">
            <option value="auto">auto — local then cloud, else heuristic</option>
            <option value="heuristic">heuristic only (deterministic)</option>
            <option value="ollama">ollama (local)</option>
            <option value="openai">openai-compatible</option>
          </select>
          <button className="btn-gold btn mt-2" onClick={() => void save("ai", { provider: providerValue })}>save ai mode</button>
          <p className="mt-1.5 text-[9.5px] text-dim">Provider endpoints and keys are read from server environment variables only — see .env.example; nothing is entered in this UI and nothing secret reaches the browser.</p>
        </Panel>
        <Panel title="operator token (this device only)">
          <div className="flex flex-wrap items-end gap-1.5">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[10.5px]"><span className="eyebrow">mutation token — the value of the server secret configured out-of-band</span>
              <input className="input" type="password" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder={savedToken ? "token IS stored on this device (set a new one to replace)" : "no token stored on this device"} autoComplete="off" />
            </label>
            <button className="btn" onClick={() => { setAsaToken(tokenDraft.trim() || null); setTokenDraft(""); setMsg(tokenDraft.trim() ? "token kept in this browser's localStorage — sent only as x-asa-token on mutations" : "token cleared from this device"); }}>save token</button>
            <button className="btn" onClick={() => { setAsaToken(null); setTokenDraft(""); setMsg("token cleared from this device"); }}>clear</button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">{savedToken ? "Stored on this device: yes. " : "Stored on this device: no. "}Production deployments fail closed: every mutation (settings, journal, AI Clone, backtest) is denied until this device holds the token configured on the server. The token is never read from the bundle — only from this field — and never leaves the browser except as the request header the server itself requires.</p>
        </Panel>
        <Panel title="masked environment (server)">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px]">
            <span className="text-muted">TTT base</span><span className="mono text-end">{String(ttt?.base ?? "—")}</span>
            <span className="text-muted">TTT key</span><span className="mono text-end">{String(ttt?.key ?? "—")}</span>
            <span className="text-muted">TTT rate/min</span><span className="mono text-end">{String(ttt?.rate_per_min ?? "—")}</span>
            <span className="text-muted">ollama</span><span className="mono text-end">{String(ai?.ollama ?? "—")}</span>
            <span className="text-muted">openai</span><span className="mono text-end">{String(ai?.openai ?? "—")}</span>
            <span className="text-muted">telegram</span><span className="mono text-end">{String(env?.telegram ?? "—")}</span>
            <span className="text-muted">news rss</span><span className="mono text-end">{String(news?.rss ?? "—")}</span>
            <span className="text-muted">db path</span><span className="mono text-end">{String(env?.db_path ?? "—")}</span>
            <span className="text-muted">api token</span><span className="mono text-end">{String(env?.api_token ?? "—")}</span>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">{cfg.data?.note ?? "secrets never leave the server — masked as CONFIGURED/NOT CONFIGURED"}</p>
        </Panel>
      </div>
      {msg && <div role="status" className="text-[11.5px]" style={{ color: msg.startsWith("saved") ? "var(--color-up)" : "var(--color-down)" }}>{msg}</div>}
    </div>
  );
}
