"use client";
/** AI Clone — grounded assistant: deterministic context (authoritative, verbatim) +
 *  optional LLM explanation that may only restate that context. */
import { useEffect, useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll, postJson, fmtAge } from "@/components/hooks";
import { Panel, Badge } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";

interface AiStatusShape { ok: boolean; providers: { id: string; configured: boolean; online: boolean | null; model: string | null; latency_ms: number | null; error: string | null }[] }
interface CloneLlmInfo { provider: string | null; model: string | null; status: "ok" | "fallback" | "disabled"; error: string | null; latency_ms: number | null }
/** `facts` = deterministic context (authoritative, always verbatim). `explanation` =
 *  LLM text, structurally separate so it can never alter/reorder the facts. */
interface CloneShape { ok: boolean; question?: string; symbol?: string | null; facts: string[]; explanation: string | null; tags: string[]; llm_online: boolean; llm: CloneLlmInfo; ts?: number }
/** Age label for a received answer — a cached answer is never presented as current. */
function answerAge(ts: number | undefined, nowMs: number): string | null {
  if (typeof ts !== "number") return null;
  const age = Math.max(0, nowMs - ts);
  if (age < 30_000) return null;
  return `answered ${fmtAge(age)} ago — snapshot, not live`;
}

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
  // a render-time clock — the answer-age label must tick without impure Date.now() in render
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<CloneShape[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    // postJson attaches the operator token in production (mutations are
    // fail-closed server-side) and distinguishes "server refused" from
    // "request never arrived" — never a fabricated answer in either case.
    const j = await postJson<Partial<CloneShape> & { error?: string }>("/api/ai-clone", { question: question.trim() });
    const now = Date.now();
    if (!j.ok) {
      // Explicit server verdict (401/400/503 fail-closed) or transport loss.
      const netLike = j.status === 0;
      setHistory((h) => [...h.slice(-19), {
        ok: false,
        ts: now,
        facts: [`${netLike ? t("conn", "questionNotSent") : "SERVER REFUSED"} · ${j.error ?? "unknown error"}`],
        explanation: null,
        tags: [netLike ? "transport failure" : `HTTP ${j.status}`],
        llm_online: false,
        llm: { provider: null, model: null, status: "disabled", error: j.error ?? null, latency_ms: null },
      }]);
      setBusy(false);
      return;
    }
    const j2 = j.data ?? {};
    setHistory((h) => [...h.slice(-19), {
      ok: true,
      ts: j2.ts ?? now,
      question: j2.question,
      symbol: j2.symbol ?? null,
      facts: j2.facts ?? [],
      explanation: j2.explanation ?? null,
      tags: j2.tags ?? [],
      llm_online: j2.llm_online ?? false,
      llm: j2.llm ?? { provider: null, model: null, status: "disabled", error: null, latency_ms: null },
    }]);
    setBusy(false);
  };

  const providers = status.data?.providers ?? [];

  return (
    <div className="grid gap-2 xl:grid-cols-[1fr_300px]">
      <div className="flex flex-col gap-2">
        <PageHead
          title={t("nav", "ai")}
          sub="grounded answers only — deterministic facts verbatim, LLM explanation strictly separate and clearly badged"
          right={busy ? <span className="mono text-[10px] text-warn">working…</span> : undefined}
        />
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
            <Panel key={i} className="rise" i={i % 6}>
              {h.question && (
                <p className="mb-1.5 border-s-2 ps-2 text-[12px] leading-snug text-muted" style={{ borderColor: "var(--color-gold-3)" }} dir="auto">
                  <span className="eyebrow me-1.5">Q</span>{h.question}
                </p>
              )}
              <div className="mb-1 flex flex-wrap items-center gap-1">
                {h.tags.map((tag) => <Badge key={tag} color="var(--color-gold)">{tag}</Badge>)}
                {h.llm.status === "ok" && <Badge color="var(--color-up)">LLM · {h.llm.provider}{h.llm.model ? ` · ${h.llm.model}` : ""}</Badge>}
                {h.llm.status === "fallback" && (
                  <Badge color="var(--color-down)">LLM FAILED — deterministic facts only{h.llm.error ? ` (${h.llm.error})` : ""}</Badge>
                )}
                {h.llm.status === "disabled" && h.ok && <Badge color="var(--color-dim)">no LLM provider — deterministic assembly</Badge>}
                {h.ok && nowMs !== null && answerAge(h.ts, nowMs) && <span className="text-[9.5px] text-warn">{answerAge(h.ts, nowMs)}</span>}
              </div>
              {h.explanation !== null && (
                <div className="evidence mb-2 p-2">
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
                  <span className="ms-2 normal-case tracking-normal" style={{ color: "var(--color-dim)" }}>{t("ai", "contextNote")}</span>
                </p>
                <ul className="space-y-1 text-[12px] leading-relaxed">
                  {h.facts.map((a, j) => {
                    const kind = a.startsWith("FACT:") ? "FACT" : a.startsWith("RULE:") ? "RULE" : a.startsWith("UNAVAILABLE:") ? "UNAVAILABLE" : null;
                    const color = kind === "FACT" ? "var(--color-up)" : kind === "RULE" ? "var(--color-gold)" : kind === "UNAVAILABLE" ? "var(--color-muted)" : undefined;
                    return (
                      <li key={j} className="whitespace-pre-wrap text-muted" dir="auto">
                        {kind && <span className="mono me-1 rounded border px-1 text-[9px] font-bold" style={{ color, borderColor: `${color}55` }}>{kind}</span>}
                        {a}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </Panel>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Panel title="providers (measured)">
          {status.status !== "OK" && (
            <TruthState dense status={status.status} failure={status.failure} onRetry={status.refresh} staleAgeMs={status.data ? status.stale_age_ms : null} />
          )}
          {status.status === "OK" && status.error && (
            <p className="mb-2 text-[10px] font-semibold" style={{ color: "var(--color-warn)" }}>
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
                    <span style={{ color: p.online === true ? "var(--color-up)" : p.configured ? "var(--color-warn)" : "var(--color-dim)" }}>
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
