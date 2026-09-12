"use client";
/** AI Clone — grounded assistant over live measured state (tagged answers). */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Panel, Badge } from "@/components/ui";

interface AiStatusShape { ok: boolean; providers: { id: string; configured: boolean; online: boolean | null; model: string | null; latency_ms: number | null; error: string | null }[] }
interface CloneShape { ok: boolean; answer: string[]; tags: string[]; llm_online: boolean }

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
      const j = (await res.json()) as CloneShape & { error?: string };
      setHistory((h) => [...h.slice(-19), { ...j, answer: j.error ? [`ERROR: ${j.error}`] : j.answer, tags: j.tags ?? [], llm_online: j.llm_online ?? false }]);
    } finally {
      setBusy(false);
    }
  };

  const providers = status.data?.providers ?? [];
  const llm = providers.filter((p) => p.id !== "heuristic");
  const llmOnline = llm.some((p) => p.online);

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
                {h.llm_online && <Badge color="#3fb68b">LLM ONLINE</Badge>}
              </div>
              <ul className="space-y-1 text-[12px] leading-relaxed">
                {h.answer.map((a, j) => <li key={j} className="whitespace-pre-wrap text-muted">{a}</li>)}
              </ul>
            </Panel>
          ))}
        </div>
      </div>
      <Panel title="providers (measured)">
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
          heuristic = deterministic evidence assembly, NOT an LLM. Configure the local or OpenAI-compatible provider via server environment variables (see .env.example) for a real LLM. Health is probed every ~15 s; nothing claims online without a probe.
        </p>
      </Panel>
    </div>
  );
}
