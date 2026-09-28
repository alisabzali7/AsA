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

interface ConfigShape { ok: boolean; env: Record<string, unknown>; prefs: Record<string, string>; note?: string }

export default function SettingsPage() {
  const { lang, setLang, t } = useLang();
  const toast = useToast();
  const [theme, setTheme] = themePref.use();
  const [density, setDensity] = densityPref.use();
  const [motion, setMotion] = motionPref.use();
  const [rail, setRail] = railPref.use();
  const { isInstallable, isStandalone, triggerInstall } = usePwaInstall();

  const cfg = usePoll<ConfigShape>("/api/system/config", 20000);
  const prefs = cfg.data?.prefs;
  // EDIT BUFFERS ONLY — the authoritative value is read from the server at
  // render (`edited ?? prefs[...]`), so the form never presents invented
  // defaults as if they were the active configuration.
  const [equity, setEquity] = useState<string | null>(null);
  const [perTrade, setPerTrade] = useState<string | null>(null);
  const [maxLev, setMaxLev] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  // the stored token lives in an external store (localStorage) — subscribed
  // via useSyncExternalStore, so no effect-driven hydration and no hydration
  // mismatch: the server snapshot is always "unknown", revealed after mount.
  const savedToken = useSyncExternalStore(subscribeAsaToken, getAsaTokenSnapshot, getAsaTokenServerSnapshot);

  const save = async (section: "risk" | "ai", body: Record<string, unknown>) => {
    setMsg(null);
    const j = await postJson<{ ok: boolean; error?: string }>("/api/system/config", { section, ...body });
    const ok = j.ok;
    setMsg(ok ? `saved (${section}) — applied to the next scan` : `${j.error ?? "failed"}${j.status === 503 ? " (production is fail-closed until the operator token below is set)" : ""}`);
    toast.push(ok
      ? { title: `settings saved (${section})`, body: "the server acknowledged — applied to the next scan", tone: "success" }
      : { title: `settings NOT saved (${section})`, body: j.error ?? `HTTP ${j.status}`, tone: "error" });
    cfg.refresh();
  };

  const replayIntro = () => {
    try {
      sessionStorage.removeItem("asa_intro_seen");
      window.location.href = "/";
    } catch {
      window.location.href = "/";
    }
  };

  const env = cfg.data?.env as Record<string, unknown> | undefined;
  const val = (edited: string | null, server: string | undefined) => edited ?? server ?? "";
  const ttt = env?.ttt as Record<string, unknown> | undefined;
  const ai = env?.ai as Record<string, unknown> | undefined;

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
        <Panel title="risk defaults (deterministic engine)">
          <div className="grid grid-cols-3 gap-1.5">
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">equity (USD)</span><input className="input" type="number" value={val(equity, prefs?.["risk.equity"])} placeholder={cfg.status === "OK" ? "unset (env default)" : "loading…"} onChange={(e) => setEquity(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">risk/trade %</span><input className="input" type="number" step="0.1" value={val(perTrade, prefs?.["risk.perTradePct"])} placeholder={cfg.status === "OK" ? "unset (env default)" : "loading…"} onChange={(e) => setPerTrade(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[10.5px]"><span className="eyebrow">max leverage</span><input className="input" type="number" value={val(maxLev, prefs?.["risk.maxLeverage"])} placeholder={cfg.status === "OK" ? "unset (env default)" : "loading…"} onChange={(e) => setMaxLev(e.target.value)} /></label>
          </div>
          <button className="btn-gold btn mt-2" onClick={() => void save("risk", { ...(equity !== null ? { equity } : {}), ...(perTrade !== null ? { perTradePct: perTrade } : {}), ...(maxLev !== null ? { maxLeverage: maxLev } : {}) })}>save risk</button>
          <p className="mt-1.5 text-[9.5px] text-dim">The risk engine applies saved values to every scan. These are advisory suggestions; you size and execute.</p>
        </Panel>
        <Panel title="AI mode">
          <select className="input" value={val(provider, prefs?.["ai.provider"]) || "auto"} onChange={(e) => setProvider(e.target.value)} aria-label="AI provider mode">
            <option value="auto">auto — local then cloud, else heuristic</option>
            <option value="heuristic">heuristic only (deterministic)</option>
            <option value="ollama">ollama (local)</option>
            <option value="openai">openai-compatible</option>
          </select>
          <button className="btn-gold btn mt-2" onClick={() => void save("ai", { provider })}>save ai mode</button>
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
            <span className="text-muted">news rss</span><span className="mono text-end">{String((env?.news as Record<string, unknown>)?.rss ?? "—")}</span>
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
