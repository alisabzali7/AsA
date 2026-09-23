"use client";
/** AI Clone — grounded assistant: deterministic context (authoritative, verbatim) +
 *  optional LLM explanation that may only restate that context. */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll, fmtAge } from "@/components/hooks";
import { Panel, Badge } from "@/components/ui";

interface AiStatusShape { ok: boolean; providers: { id: string; configured: boolean; online: boolean | null; model: string | null; latency_ms: number | null; error: string | null }[] }
interface CloneLlmInfo { provider: string | null; model: string | null; status: "ok" | "fallback" | "disabled"; error: string | null; latency_ms: number | null }
/** `facts` = deterministic context (authoritative, always verbatim). `explanation` =
 *  LLM text, structurally separate so it can never alter/reorder the facts. */
interface CloneShape { ok: boolean; question?: string; symbol?: string | null; facts: string[]; explanation: string | null; tags: string[]; llm_online: boolean; llm: CloneLlmInfo; ts?: number }

const SUGGESTIONS = [
  "What is the state of BTCUSDT right now?",
  "Is there liquidation pressure?",
  "What does AsA know about funding?",
  "Can AsA place an order for me?",
  "How much history is loaded for ETHUSDT?",
];

export default function AiClonePage() {
  const { t } = useLang();
  const status = usePoll<AiStatusShape>("/api/ai/status", 20000);
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<CloneShape[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ai-clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      const j = (await res.json()) as Partial<CloneShape> & { error?: string };
      if (j.ok === false) {
        // Server answered with an explicit error: show it, never fabricate an answer.
        setHistory((h) => [...h.slice(-19), { ok: false, facts: [`ERROR: ${j.error ?? "unknown error"}`], explanation: null, tags: [], llm_online: false, llm: { provider: null, model: null, status: "disabled", error: j.error ?? null, latency_ms: null } }]);
        return;
      }
      setHistory((h) => [...h.slice(-19), {
        ok: true,
        question: j.question,
        symbol: j.symbol ?? null,
        facts: j.facts ?? [],
        explanation: j.explanation ?? null,
        tags: j.tags ?? [],
        llm_online: j.llm_online ?? false,
        llm: j.llm ?? { provider: null, model: null, status: "disabled", error: null, latency_ms: null },
      }]);
    } catch (e) {
      // Offline/server-unreachable: the question was NOT sent. Record it as a
      // visible, honest failure — never as a pending or fabricated answer.
      const msg = e instanceof Error ? e.message : String(e);
      const netDown = typeof navigator !== "undefined" && !navigator.onLine;
      setHistory((h) => [
        ...h.slice(-19),
        {
          ok: false,
          facts: [`${t("conn", "questionNotSent")} · ${msg}`],
          explanation: null,
          tags: [t("conn", netDown ? "offline" : "degraded")],
          llm_online: false,
          llm: { provider: null, model: null, status: "disabled", error: msg, latency_ms: null },
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const providers = status.data?.providers ?? [];

  return (
    <div className="grid gap-2 xl:grid-cols-[1fr_300px]">
      <div className="flex flex-col gap-2">
        <h1 className="text-[15px] font-semibold">{t("nav", "ai")}</h1>
        <Panel className="p-2">
          <textarea
            className="input min-h-[80px]"
            placeholder="Ask about live market state, metrics, coverage, risk, strategy… (grounded, tagged answers)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(q); }}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button className="btn-gold btn" disabled={busy} onClick={() => void ask(q)}>{busy ? "…" : "ask"}</button>
            {SUGGESTIONS.map((s) => <button key={s} className="btn" onClick={() => { setQ(s); void ask(s); }}>{s.length > 42 ? `${s.slice(0, 42)}…` : s}</button>)}
          </div>
        </Panel>
        <div className="flex flex-col gap-2">
          {history.map((h, i) => (
            <Panel key={i}>
              <div className="mb-1 flex flex-wrap gap-1">
                {h.tags.map((tag) => <Badge key={tag} color="#d4b874">{tag}</Badge>)}
                {h.llm.status === "ok" && <Badge color="#3fb68b">LLM · {h.llm.provider}{h.llm.model ? ` · ${h.llm.model}` : ""}</Badge>}
              </div>
              {h.explanation !== null && (
                <div className="mb-2 rounded border hairline p-2">
                  <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-gold">
                    {t("ai", "explanation")}
                    {h.llm.provider && <span dir="ltr" className="mono normal-case tracking-normal text-dim"> · {h.llm.provider} · {h.llm.model ?? ""} · {h.llm.latency_ms ?? 0}ms</span>}
                  </p>
                  <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-text">{h.explanation}</div>
                </div>
              )}
              <div>
                <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--color-muted)" }}>
                  {t("ai", "context")}
                  <span className="ml-2 normal-case tracking-normal" style={{ color: "var(--color-dim)" }}>{t("ai", "contextNote")}</span>
                </p>
                <ul className="space-y-1 text-[12px] leading-relaxed">
                  {h.facts.map((a, j) => <li key={j} className="whitespace-pre-wrap text-muted" dir="auto">{a}</li>)}
                </ul>
              </div>
            </Panel>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Panel title="providers (measured)">
          {status.error && (
            <p className="mb-2 text-[10px] font-semibold" style={{ color: "#d6a24a" }}>
              {t("conn", "providerStatusUnavailable")}
              {status.age_ms !== null && (
                <>
                  {" · "}
                  {t("conn", "lastContact")}{" "}
                  <span dir="ltr" className="mono">{fmtAge(status.age_ms)}</span>
                </>
              )}
            </p>
          )}
          <table className="tbl w-full">
            <thead><tr><th>id</th><th>status</th><th>model</th></tr></thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.id}</td>
                  <td>
                    <span style={{ color: p.online === true ? "#3fb68b" : p.configured ? "#d6a24a" : "#5d616b" }}>
                      {p.online === true ? "ONLINE" : p.configured ? (p.online === null ? "PROBING" : "OFFLINE") : "NOT CONFIGURED"}
                    </span>
                  </td>
                  <td className="mono text-dim">{p.model ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] leading-relaxed text-muted">
            heuristic = deterministic evidence assembly, NOT an LLM. Configure the local or OpenAI-compatible provider via server environment variables (see .env.example) — a real LLM then adds an <span className="text-text">{t("ai", "explanation").toLowerCase()}</span> over the deterministic context; it can never change that context.
          </p>
        </Panel>
        <Panel className="p-2">
          <p className="text-[10px] leading-relaxed text-dim">{t("ai", "footnote")}</p>
        </Panel>
      </div>
    </div>
  );
}
