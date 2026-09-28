"use client";
/** AI Clone — grounded assistant: deterministic context (authoritative, verbatim) +
 * optional LLM explanation that may only restate that context. */
import { useEffect, useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll, postJson, fmtAge } from "@/components/hooks";
import { Panel, Badge } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";

interface AiStatusShape {
  ok: boolean;
  provider_mode?: string;
  providers: { id: string; configured: boolean; online: boolean | null; model: string | null; latency_ms: number | null; error: string | null }[];
}
interface CloneLlmInfo {
  provider: string | null;
  model: string | null;
  status: "ok" | "fallback" | "disabled";
  error: string | null;
  latency_ms: number | null;
}
interface CloneOutputValidation {
  status: string;
  semantic_status: "NOT_PROVEN";
  displayed: boolean;
  unsupported_numbers: string[];
  unsupported_symbols: string[];
  authority_violations: string[];
  note: string;
}
/** Deterministic facts/context are authoritative; LLM prose is separate, non-authoritative, and not semantically proven. */
interface CloneShape {
  ok: boolean;
  question?: string;
  symbol?: string | null;
  provider_mode?: string;
  facts: string[];
  ai_context?: Record<string, unknown>;
  explanation: string | null;
  explanation_authority?: string;
  explanation_validation?: CloneOutputValidation | null;
  tags: string[];
  llm_online: boolean;
  llm: CloneLlmInfo;
  ts?: number;
}

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
  // A render-time clock — the answer-age label must tick without impure Date.now() in render.
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
    // postJson attaches the operator token in production and distinguishes a
    // server refusal from a request that never arrived.
    const result = await postJson<Partial<CloneShape> & { error?: string }>("/api/ai-clone", { question: question.trim() });
    const now = Date.now();
    if (!result.ok) {
      const netLike = result.status === 0;
      setHistory((items) => [...items.slice(-19), {
        ok: false,
        ts: now,
        question: question.trim(),
        facts: [`${netLike ? t("conn", "questionNotSent") : "SERVER REFUSED"} · ${result.error ?? "unknown error"}`],
        explanation: null,
        tags: [netLike ? "transport failure" : `HTTP ${result.status}`],
        llm_online: false,
        llm: { provider: null, model: null, status: "disabled", error: result.error ?? null, latency_ms: null },
      }]);
      setBusy(false);
      return;
    }

    const data = result.data ?? {};
    setHistory((items) => [...items.slice(-19), {
      ok: true,
      ts: data.ts ?? now,
      question: data.question,
      symbol: data.symbol ?? null,
      provider_mode: data.provider_mode,
      facts: data.facts ?? [],
      ai_context: data.ai_context,
      explanation: data.explanation ?? null,
      explanation_authority: data.explanation_authority,
      explanation_validation: data.explanation_validation ?? null,
      tags: data.tags ?? [],
      llm_online: data.llm_online ?? false,
      llm: data.llm ?? { provider: null, model: null, status: "disabled", error: null, latency_ms: null },
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
            {SUGGESTIONS.map((suggestion) => <button key={suggestion} className="btn" onClick={() => { setQ(suggestion); void ask(suggestion); }}>{suggestion.length > 42 ? `${suggestion.slice(0, 42)}…` : suggestion}</button>)}
          </div>
        </Panel>
        <div className="flex flex-col gap-2">
          {history.map((item, index) => (
            <Panel key={index} className="rise" i={index % 6}>
              {item.question && (
                <p className="mb-1.5 border-s-2 ps-2 text-[12px] leading-snug text-muted" style={{ borderColor: "var(--color-gold-3)" }} dir="auto">
                  <span className="eyebrow me-1.5">Q</span>{item.question}
                </p>
              )}
              <div className="mb-1 flex flex-wrap items-center gap-1">
                {item.tags.map((tag) => <Badge key={tag} color="var(--color-gold)">{tag}</Badge>)}
                {item.provider_mode && <Badge color="var(--color-dim)">mode · {item.provider_mode}</Badge>}
                {item.llm.status === "ok" && item.explanation !== null && <Badge color="var(--color-up)">LLM · {item.llm.provider}{item.llm.model ? ` · ${item.llm.model}` : ""}</Badge>}
                {item.llm.status === "fallback" && (
                  <Badge color="var(--color-down)">LLM FAILED — deterministic facts only{item.llm.error ? ` (${item.llm.error})` : ""}</Badge>
                )}
                {item.llm.status === "disabled" && item.ok && <Badge color="var(--color-dim)">no LLM provider — deterministic assembly</Badge>}
                {item.ok && nowMs !== null && answerAge(item.ts, nowMs) && <span className="text-[9.5px] text-warn">{answerAge(item.ts, nowMs)}</span>}
              </div>
              {item.explanation !== null && (
                <div className="evidence mb-2 p-2">
                  <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-gold">
                    {t("ai", "explanation")}
                    {item.llm.provider && <span dir="ltr" className="mono normal-case tracking-normal text-dim"> · {item.llm.provider} · {item.llm.model ?? ""} · {item.llm.latency_ms ?? 0}ms</span>}
                  </p>
                  <p className="mb-1 text-[9.5px] text-dim">{t("ai", "nonAuthoritative")}{item.explanation_validation ? ` · ${item.explanation_validation.status}` : ""}</p>
                  <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-text">{item.explanation}</div>
                </div>
              )}
              <div>
                <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--color-muted)" }}>
                  {t("ai", "context")}
                  <span className="ms-2 normal-case tracking-normal" style={{ color: "var(--color-dim)" }}>{t("ai", "contextNote")}</span>
                </p>
                <ul className="space-y-1 text-[12px] leading-relaxed">
                  {item.facts.map((fact, factIndex) => {
                    const kind = fact.startsWith("FACT:") ? "FACT" : fact.startsWith("RULE:") ? "RULE" : fact.startsWith("UNAVAILABLE:") ? "UNAVAILABLE" : null;
                    const color = kind === "FACT" ? "var(--color-up)" : kind === "RULE" ? "var(--color-gold)" : kind === "UNAVAILABLE" ? "var(--color-muted)" : undefined;
                    return (
                      <li key={factIndex} className="whitespace-pre-wrap text-muted" dir="auto">
                        {kind && <span className="mono me-1 rounded border px-1 text-[9px] font-bold" style={{ color, borderColor: `${color}55` }}>{kind}</span>}
                        {fact}
                      </li>
                    );
                  })}
                </ul>
              </div>
              {item.ai_context && (
                <details className="mt-2 rounded border hairline p-2">
                  <summary className="cursor-pointer text-[10px] text-dim">{t("ai", "exactProviderContext")}</summary>
                  <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-[9px] text-muted" dir="ltr">{JSON.stringify(item.ai_context, null, 2)}</pre>
                </details>
              )}
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
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <td className="font-medium">{provider.id}</td>
                  <td>
                    <span style={{ color: provider.online === true ? "var(--color-up)" : provider.configured ? "var(--color-warn)" : "var(--color-dim)" }}>
                      {provider.online === true ? "ONLINE" : provider.configured ? (provider.online === null ? "PROBING" : "OFFLINE") : "NOT CONFIGURED"}
                    </span>
                  </td>
                  <td className="mono text-dim">{provider.model ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {status.data?.provider_mode && <p className="mt-1 text-[9.5px] text-dim">selected mode · {status.data.provider_mode}</p>}
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
