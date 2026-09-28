"use client";
/**
 * AI Clone — grounded assistant: deterministic context (authoritative, verbatim) +
 * optional LLM explanation that may only restate that context.
 *
 * Truth boundary:
 * - What is deterministic: FACT (green), RULE (gold), UNAVAILABLE (dim)
 * - What is AI generated: EXPLANATION (badged with provider/model)
 * - What is stale: answered >30s ago
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useLang } from "@/components/lang";
import { usePoll, postJson, fmtAge } from "@/components/hooks";
import { Panel, Badge, Button, IconButton } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";
import { useSelection } from "@/components/selection";
import { useToast } from "@/components/toast";
import { IconAi, IconChart, IconCheck, IconClose, IconCopy, IconRefresh, IconZap } from "@/components/icons";

interface AiStatusShape {
  ok: boolean;
  providers: { id: string; configured: boolean; online: boolean | null; model: string | null; latency_ms: number | null; error: string | null }[];
}

interface CloneLlmInfo {
  provider: string | null;
  model: string | null;
  status: "ok" | "fallback" | "disabled";
  error: string | null;
  latency_ms: number | null;
}

interface CloneShape {
  ok: boolean;
  question?: string;
  symbol?: string | null;
  facts: string[];
  explanation: string | null;
  tags: string[];
  llm_online: boolean;
  llm: CloneLlmInfo;
  ts?: number;
}

function answerAge(ts: number | undefined, nowMs: number): string | null {
  if (typeof ts !== "number") return null;
  const age = Math.max(0, nowMs - ts);
  if (age < 30_000) return null;
  return `answered ${fmtAge(age)} ago — snapshot, not live`;
}

const CATEGORIZED_SUGGESTIONS = [
  { label: "Market State", q: "What is the state of BTCUSDT right now?" },
  { label: "Liquidation", q: "Is there liquidation pressure or CVD?" },
  { label: "Funding & Bias", q: "What does AsA know about universe funding?" },
  { label: "Execution Limits", q: "Can AsA place an order for me?" },
  { label: "Data Coverage", q: "How much history is loaded for ETHUSDT?" },
];

function AiCloneInner() {
  const { t } = useLang();
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const initialQ = sp.get("q") ?? "";

  const [sel, setSel] = useSelection();
  const status = usePoll<AiStatusShape>("/api/ai/status", 20000);

  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const [q, setQ] = useState(initialQ);
  const [history, setHistory] = useState<CloneShape[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = async (questionText: string) => {
    const query = questionText.trim();
    if (!query || busy) return;
    setBusy(true);

    const now = Date.now();
    const j = await postJson<Partial<CloneShape> & { error?: string }>("/api/ai-clone", { question: query });

    if (!j.ok) {
      const netLike = j.status === 0;
      setHistory((h) => [
        ...h.slice(-19),
        {
          ok: false,
          ts: now,
          question: query,
          facts: [`${netLike ? t("conn", "questionNotSent") : "SERVER REFUSED"} · ${j.error ?? "unknown error"}`],
          explanation: null,
          tags: [netLike ? "transport failure" : `HTTP ${j.status}`],
          llm_online: false,
          llm: { provider: null, model: null, status: "disabled", error: j.error ?? null, latency_ms: null },
        },
      ]);
      setBusy(false);
      return;
    }

    const j2 = j.data ?? {};
    setHistory((h) => [
      ...h.slice(-19),
      {
        ok: true,
        ts: j2.ts ?? now,
        question: j2.question ?? query,
        symbol: j2.symbol ?? null,
        facts: j2.facts ?? [],
        explanation: j2.explanation ?? null,
        tags: j2.tags ?? [],
        llm_online: j2.llm_online ?? false,
        llm: j2.llm ?? { provider: null, model: null, status: "disabled", error: null, latency_ms: null },
      },
    ]);
    setBusy(false);
  };

  // Run initial query if provided in URL
  useEffect(() => {
    if (initialQ) {
      const timer = setTimeout(() => {
        void ask(initialQ);
      }, 50);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  const copyFacts = (item: CloneShape) => {
    const text = [
      `Q: ${item.question}`,
      ...(item.explanation ? [`Explanation:\n${item.explanation}\n`] : []),
      "Deterministic Facts:",
      ...item.facts.map((f) => `· ${f}`),
    ].join("\n");
    navigator.clipboard.writeText(text);
    toast.push({ title: "Response copied to clipboard", tone: "success" });
  };

  const providers = status.data?.providers ?? [];

  return (
    <div className="grid gap-2 xl:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-2">
        <PageHead
          title={t("nav", "ai")}
          sub="grounded answers only — deterministic facts verbatim, LLM explanation strictly separate and clearly badged"
          right={
            sel.symbol ? (
              <span className="mono text-[11px] text-gold border hairline rounded px-2 py-0.5">
                Context: {sel.symbol}
              </span>
            ) : undefined
          }
        />

        {/* Question Input Card */}
        <Panel className="p-3">
          <textarea
            className="input min-h-[85px] text-[13px]"
            placeholder="Ask about live market state, metrics, coverage, risk, strategy… (grounded, tagged answers)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(q);
            }}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button variant="gold" disabled={busy || !q.trim()} onClick={() => void ask(q)}>
                {busy ? (
                  <span className="flex items-center gap-1.5">
                    <span className="breathe h-1.5 w-1.5 rounded-full bg-current" />
                    processing…
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <IconZap size={13} /> Ask Clone
                  </span>
                )}
              </Button>
              <span className="text-[10px] text-dim hidden sm:inline">Press ⌘+Enter to send</span>
            </div>

            <div className="flex flex-wrap gap-1">
              {CATEGORIZED_SUGGESTIONS.map((s) => (
                <button
                  key={s.q}
                  className="focus-ring chip cursor-pointer hover:!border-gold-3"
                  onClick={() => {
                    setQ(s.q);
                    void ask(s.q);
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </Panel>

        {/* Conversation History */}
        <div className="flex flex-col gap-2">
          {busy && (
            <Panel className="rise p-3">
              <div className="flex items-center gap-2 text-[12px] text-gold">
                <span className="breathe h-2 w-2 rounded-full bg-gold" />
                <span>AsA AI Clone is evaluating deterministic evidence…</span>
              </div>
            </Panel>
          )}

          {history.map((h, i) => (
            <Panel key={i} className="rise p-3" i={i % 6}>
              {/* Question Header */}
              {h.question && (
                <div className="mb-2 flex items-start justify-between gap-2 border-s-2 ps-2.5" style={{ borderColor: "var(--color-gold-3)" }}>
                  <div className="text-[13px] font-medium leading-snug text-text" dir="auto">
                    <span className="eyebrow text-gold me-2">Q</span>
                    {h.question}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <IconButton label="copy response" onClick={() => copyFacts(h)}>
                      <IconCopy size={13} />
                    </IconButton>
                    {h.symbol && (
                      <IconButton
                        label={`open ${h.symbol} on chart`}
                        onClick={() => {
                          setSel({ symbol: h.symbol, returnTo: "/ai-clone" });
                          router.push(`/chart?symbol=${h.symbol}`);
                        }}
                      >
                        <IconChart size={13} />
                      </IconButton>
                    )}
                  </div>
                </div>
              )}

              {/* Status Badges */}
              <div className="mb-2.5 flex flex-wrap items-center gap-1.5" dir="ltr">
                {h.tags.map((tag) => (
                  <Badge key={tag} color="var(--color-gold)">{tag}</Badge>
                ))}
                {h.llm.status === "ok" && (
                  <Badge color="var(--color-up)">
                    LLM · {h.llm.provider} {h.llm.model ? `· ${h.llm.model}` : ""} ({h.llm.latency_ms ?? 0}ms)
                  </Badge>
                )}
                {h.llm.status === "fallback" && (
                  <Badge color="var(--color-down)">
                    LLM FAILED — deterministic facts only{h.llm.error ? ` (${h.llm.error})` : ""}
                  </Badge>
                )}
                {h.llm.status === "disabled" && h.ok && (
                  <Badge color="var(--color-dim)">deterministic assembly (no LLM provider)</Badge>
                )}
                {h.ok && nowMs !== null && answerAge(h.ts, nowMs) && (
                  <span className="text-[9.5px] text-warn mono">{answerAge(h.ts, nowMs)}</span>
                )}
              </div>

              {/* LLM Explanation Section (Clearly Separate) */}
              {h.explanation !== null && (
                <div className="evidence mb-3 p-2.5 bg-[rgba(216,188,120,0.03)] rounded-md border hairline">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-gold flex items-center gap-1.5">
                    <IconAi size={12} />
                    {t("ai", "explanation")}
                  </p>
                  <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-text" dir="auto">
                    {h.explanation}
                  </div>
                </div>
              )}

              {/* Deterministic Context Section */}
              <div>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted flex items-center justify-between">
                  <span>
                    {t("ai", "context")}
                    <span className="ms-2 normal-case tracking-normal text-dim font-normal">
                      ({t("ai", "contextNote")})
                    </span>
                  </span>
                </p>
                <ul className="space-y-1 text-[12px] leading-relaxed">
                  {h.facts.map((a, j) => {
                    const kind = a.startsWith("FACT:")
                      ? "FACT"
                      : a.startsWith("RULE:")
                      ? "RULE"
                      : a.startsWith("UNAVAILABLE:")
                      ? "UNAVAILABLE"
                      : null;
                    const color =
                      kind === "FACT"
                        ? "var(--color-up)"
                        : kind === "RULE"
                        ? "var(--color-gold)"
                        : kind === "UNAVAILABLE"
                        ? "var(--color-muted)"
                        : undefined;
                    return (
                      <li key={j} className="whitespace-pre-wrap text-muted flex items-start gap-1.5" dir="auto">
                        {kind && (
                          <span
                            dir="ltr"
                            className="mono mt-0.5 shrink-0 rounded border px-1 text-[9px] font-bold"
                            style={{ color, borderColor: `${color}55`, background: `${color}11` }}
                          >
                            {kind}
                          </span>
                        )}
                        <span className="flex-1">{a.replace(/^(FACT|RULE|UNAVAILABLE):\s*/, "")}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </Panel>
          ))}
        </div>
      </div>

      {/* Right Rail: Provider Status & Truth Grounding */}
      <div className="flex flex-col gap-2">
        <Panel title="AI Providers (Measured)">
          {status.status !== "OK" && (
            <TruthState
              dense
              status={status.status}
              failure={status.failure}
              onRetry={status.refresh}
              staleAgeMs={status.data ? status.stale_age_ms : null}
            />
          )}
          <table className="tbl w-full text-[11px]">
            <thead>
              <tr>
                <th>id</th>
                <th>status</th>
                <th>model</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.id}</td>
                  <td>
                    <span
                      style={{
                        color:
                          p.online === true
                            ? "var(--color-up)"
                            : p.configured
                            ? "var(--color-warn)"
                            : "var(--color-dim)",
                      }}
                    >
                      {p.online === true
                        ? "ONLINE"
                        : p.configured
                        ? p.online === null
                          ? "PROBING"
                          : "OFFLINE"
                        : "NOT CONFIGURED"}
                    </span>
                  </td>
                  <td className="mono text-dim">{p.model ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] leading-relaxed text-dim border-t hairline pt-2">
            Heuristic = deterministic evidence assembly, NOT an LLM. An LLM explains evidence; it cannot alter facts, create price, or execute.
          </p>
        </Panel>

        <Panel title="Truth Grounding">
          <p className="text-[10.5px] leading-relaxed text-muted">
            {t("ai", "footnote")}
          </p>
        </Panel>
      </div>
    </div>
  );
}

export default function AiClonePage() {
  return (
    <Suspense fallback={<div className="py-10 text-center text-muted">loading AI Clone…</div>}>
      <AiCloneInner />
    </Suspense>
  );
}
