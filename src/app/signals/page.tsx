"use client";
/**
 * Signals — advisory lifecycle + manual self-reported journal.
 * Includes filtering, search, Signal Detail Drawer, and Journal form.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLang } from "@/components/lang";
import { usePoll, postJson, fmtAge, formatPrice } from "@/components/hooks";
import {
  Badge,
  Button,
  Empty,
  FilterBar,
  IconButton,
  Panel,
  SearchInput,
  Stat,
  StatusBadge,
  StatusChip,
} from "@/components/ui";
import { AdaptiveDrawer } from "@/components/overlay";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";
import { useToast } from "@/components/toast";
import { useSelection } from "@/components/selection";
import { IconAi, IconChart, IconInfo, IconRefresh, IconTrash } from "@/components/icons";
import { SIGNAL_STATES as LIFECYCLE } from "@/lib/domain/signal-states";

interface DeliveryView {
  delivery_state?: string;
  attempts?: number | null;
  error?: string | null;
  sent_ms?: number | null;
  outbox_id?: number | null;
  link?: string | null;
  progress?: { photo_required: boolean; photo_sent: boolean; text_sent: boolean } | null;
}

interface SigItem {
  id: string;
  state: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  strategy_id: string;
  created_ms: number;
  updated_ms: number;
  delivery?: DeliveryView;
  opp_id?: string | null;
}

interface SigShape {
  ok: boolean;
  items: SigItem[];
}

interface JItem {
  id: number;
  created_ms: number;
  symbol: string;
  direction: string;
  notes: string;
  r_multiple: number | null;
}

interface JShape {
  ok: boolean;
  items: JItem[];
}

type DirectionFilter = "all" | "long" | "short";
type StateFilter = "all" | "published" | "expired" | "candidate" | "rejected";

export default function SignalsPage() {
  const { t } = useLang();
  const toast = useToast();
  const router = useRouter();
  const [, setSel] = useSelection();

  const [search, setSearch] = useState("");
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [selectedSignal, setSelectedSignal] = useState<SigItem | null>(null);

  const poll = usePoll<SigShape>("/api/signals?limit=100", 15000);
  const { data, refresh } = poll;
  const ready = poll.status === "OK";
  const items = useMemo(() => (ready ? data?.items ?? [] : []), [ready, data?.items]);

  const journal = usePoll<JShape>("/api/signals/journal", 10000);

  // Journal form state
  const [sym, setSym] = useState("BTCUSDT");
  const [dir, setDir] = useState<"long" | "short">("long");
  const [notes, setNotes] = useState("");
  const [r, setR] = useState("");
  const [saving, setSaving] = useState(false);

  const filteredItems = useMemo(() => {
    return items.filter((s) => {
      if (search.trim()) {
        const q = search.trim().toUpperCase();
        if (!s.symbol.toUpperCase().includes(q) && !s.strategy_id.toUpperCase().includes(q) && !s.id.toUpperCase().includes(q)) {
          return false;
        }
      }
      if (dirFilter !== "all" && s.direction.toLowerCase() !== dirFilter) return false;
      if (stateFilter !== "all" && s.state.toLowerCase() !== stateFilter) return false;
      return true;
    });
  }, [items, search, dirFilter, stateFilter]);

  const saveJournal = async () => {
    if (!sym.trim()) return;
    setSaving(true);
    const j = await postJson<{ ok: boolean; error?: string }>("/api/signals/journal", {
      symbol: sym.trim().toUpperCase(),
      direction: dir,
      notes,
      r_multiple: r === "" ? null : Number(r),
    });
    setSaving(false);
    if (j.ok) {
      setNotes("");
      setR("");
      journal.refresh();
      refresh();
      toast.push({
        title: "Journal entry stored",
        body: `${sym} · ${dir} — recorded on server. R stays self-reported.`,
        tone: "success",
      });
    } else {
      const msg = j.error ?? `failed (HTTP ${j.status})`;
      toast.push({
        title: "Journal entry failed",
        body: msg,
        tone: "error",
      });
    }
  };

  const delJournal = async (id: number) => {
    const j = await postJson(`/api/signals/journal/${id}`, undefined, "DELETE");
    if (j.ok) {
      toast.push({ title: "Journal entry removed", tone: "info" });
    } else {
      toast.push({ title: `Delete failed: ${j.error ?? "error"}`, tone: "error" });
    }
    journal.refresh();
  };

  const handleOpenChart = (sig: SigItem) => {
    setSel({ symbol: sig.symbol, tf: sig.timeframe, returnTo: "/signals" });
    router.push(`/chart?symbol=${sig.symbol}`);
  };

  const handleOpenAi = (sig: SigItem) => {
    setSel({ symbol: sig.symbol, tf: sig.timeframe, returnTo: "/signals" });
    router.push(
      `/ai-clone?q=${encodeURIComponent(
        `Explain signal ${sig.id} on ${sig.symbol} (${sig.direction} ${sig.timeframe} score ${sig.score}) state=${sig.state}.`
      )}`
    );
  };

  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
      {/* Left Column: Signals List */}
      <div className="flex flex-col gap-2">
        <PageHead
          title={t("nav", "signals")}
          sub={`Lifecycle: ${LIFECYCLE.join(" → ")} · signal ≠ order · advisory only`}
          right={
            <div className="flex items-center gap-2">
              {ready && (
                <span className="meta-strip">
                  <span className="mono iso">{items.length} records</span>
                </span>
              )}
              <button className="focus-ring btn text-[10.5px]" onClick={refresh}>
                <IconRefresh size={11} /> refresh
              </button>
            </div>
          }
        />

        {/* Filters */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={search}
              onChange={setSearch}
              onClear={() => setSearch("")}
              placeholder="Search symbol or signal ID…"
              className="w-[200px]"
            />
            <FilterBar<DirectionFilter>
              active={dirFilter}
              onChange={setDirFilter}
              filters={[
                { id: "all", label: "All" },
                { id: "long", label: "▲ Long" },
                { id: "short", label: "▼ Short" },
              ]}
            />
            <FilterBar<StateFilter>
              active={stateFilter}
              onChange={setStateFilter}
              filters={[
                { id: "all", label: "All" },
                { id: "published", label: "Published" },
                { id: "expired", label: "Expired" },
                { id: "rejected", label: "Rejected" },
              ]}
            />
          </div>

          {ready && (
            <span className="text-[11px] text-dim mono ms-auto">
              showing {filteredItems.length} of {items.length}
            </span>
          )}
        </div>

        {!ready && (
          <TruthState
            status={poll.status}
            failure={poll.failure}
            onRetry={refresh}
            staleAgeMs={data ? poll.stale_age_ms : null}
          />
        )}

        {ready && items.length === 0 && (
          <Empty text="EMPTY — the backend answered and no signals are stored. Signals require every gate, including current complete risk and empirical strategy promotion. Nothing is simulated." />
        )}

        {ready && items.length > 0 && filteredItems.length === 0 && (
          <Empty text="No signals match the selected filters." />
        )}

        {/* Signal Cards */}
        <div className="flex flex-col gap-2">
          {filteredItems.map((s, i) => (
            <div key={s.id} className="rise" style={{ ["--i" as never]: i % 8 }}>
              <Panel
                title={`${s.symbol} · ${s.direction.toUpperCase()} @ ${s.timeframe}`}
                right={
                  <div className="flex items-center gap-1.5">
                    <IconButton label="inspect signal details" onClick={() => setSelectedSignal(s)}>
                      <IconInfo size={13} />
                    </IconButton>
                    <IconButton label="open on chart" onClick={() => handleOpenChart(s)}>
                      <IconChart size={13} />
                    </IconButton>
                    <StatusChip state={s.state} label={s.state} />
                  </div>
                }
              >
                <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                  <Badge color="var(--color-gold)">score {s.score}</Badge>
                  <Badge>{s.strategy_id}</Badge>
                  <Badge
                    color={
                      s.delivery?.delivery_state === "SENT"
                        ? "var(--color-up)"
                        : s.delivery?.delivery_state === "FAILED" || s.delivery?.delivery_state === "DEAD"
                        ? "var(--color-down)"
                        : undefined
                    }
                  >
                    delivery {s.delivery?.delivery_state ?? "UNLINKED"}
                  </Badge>
                  <span className="text-dim">
                    created {new Date(s.created_ms).toLocaleString()}
                  </span>
                </div>

                <div className="mt-2 text-[10.5px] text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
                  {s.opp_id && <span>opportunity #{s.opp_id}</span>}
                  {s.delivery?.outbox_id != null && <span>· outbox #{s.delivery.outbox_id}</span>}
                  {s.delivery?.progress && (
                    <span>
                      · chart {s.delivery.progress.photo_sent ? "✓ sent" : "pending"} · text{" "}
                      {s.delivery.progress.text_sent ? "✓ sent" : "pending"}
                    </span>
                  )}
                </div>

                {s.delivery?.error && (
                  <p className="mt-1 text-[10.5px]" style={{ color: "var(--color-down)" }}>
                    delivery error: {s.delivery.error}
                  </p>
                )}

                <div className="mt-2 pt-1.5 border-t hairline flex items-center justify-between text-[9.5px] text-dim">
                  <span>Advisory only — no automatic execution. Human executes.</span>
                  <button onClick={() => setSelectedSignal(s)} className="text-gold hover:underline font-semibold">
                    inspect signal →
                  </button>
                </div>
              </Panel>
            </div>
          ))}
        </div>
      </div>

      {/* Right Column: Manual Journal Form & List */}
      <div className="flex flex-col gap-2">
        <Panel title="Manual Trade Journal">
          <div className="flex flex-wrap gap-1.5">
            <input
              className="input w-[110px]"
              value={sym}
              onChange={(e) => setSym(e.target.value.toUpperCase())}
              aria-label="symbol"
              placeholder="BTCUSDT"
            />
            <select
              className="input w-[95px]"
              value={dir}
              onChange={(e) => setDir(e.target.value as "long" | "short")}
            >
              <option value="long">long</option>
              <option value="short">short</option>
            </select>
            <input
              className="input w-[80px]"
              placeholder="R mult"
              value={r}
              onChange={(e) => setR(e.target.value)}
              aria-label="R multiple"
            />
          </div>
          <textarea
            className="input mt-1.5 min-h-[70px] text-[12px]"
            placeholder="Execution notes (entry rationale, exit result, psychological state)…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="mt-2 flex items-center justify-between">
            <Button variant="gold" disabled={saving || !sym.trim()} onClick={() => void saveJournal()}>
              {saving ? "recording…" : "Save Journal Entry"}
            </Button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim leading-relaxed">
            R multiple is self-reported. AsA never accesses your exchange account. In production, mutations require the operator token in Settings.
          </p>
        </Panel>

        <Panel
          title={`Journal History (${journal.data?.items.length ?? 0})`}
          right={<span className="meta-strip"><span className="mono iso">operator ledger</span></span>}
        >
          <div className="max-h-[440px] space-y-1.5 overflow-y-auto">
            {(journal.data?.items ?? []).map((j) => (
              <div key={j.id} className="panel-2 p-2 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{j.symbol} · {j.direction.toUpperCase()}</span>
                  <div className="flex items-center gap-1.5">
                    {j.r_multiple != null && (
                      <span
                        className="mono font-bold"
                        style={{ color: j.r_multiple >= 0 ? "var(--color-up)" : "var(--color-down)" }}
                      >
                        {j.r_multiple >= 0 ? "+" : ""}{j.r_multiple}R
                      </span>
                    )}
                    <button
                      className="text-dim hover:text-down"
                      onClick={() => void delJournal(j.id)}
                      title="delete entry"
                    >
                      <IconTrash size={11} />
                    </button>
                  </div>
                </div>
                {j.notes && <p className="mt-1 text-muted text-[10.5px] leading-snug" dir="auto">{j.notes}</p>}
                <div className="mt-1 text-[9px] text-dim mono">
                  {new Date(j.created_ms).toLocaleString()}
                </div>
              </div>
            ))}
            {(journal.data?.items?.length ?? 0) === 0 && (
              <div className="py-6 text-center text-dim text-[11px]">No manual journal entries recorded yet.</div>
            )}
          </div>
        </Panel>
      </div>

      {/* Signal Detail Drawer */}
      {selectedSignal && (
        <AdaptiveDrawer
          title={`Signal ${selectedSignal.id}`}
          sub={`${selectedSignal.symbol} · ${selectedSignal.direction.toUpperCase()} @ ${selectedSignal.timeframe}`}
          onClose={() => setSelectedSignal(null)}
          width="520px"
          badge={<StatusBadge state={selectedSignal.state} />}
        >
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 border-b hairline pb-3">
              <Button variant="gold" className="flex-1" onClick={() => handleOpenChart(selectedSignal)}>
                <IconChart size={13} /> View on Terminal
              </Button>
              <Button variant="default" className="flex-1" onClick={() => handleOpenAi(selectedSignal)}>
                <IconAi size={13} /> Ask AI Clone
              </Button>
            </div>

            <Panel title="Lifecycle & State">
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <Stat k="lifecycle state" v={selectedSignal.state} />
                <Stat k="score" v={selectedSignal.score} color="var(--color-gold)" />
                <Stat k="strategy" v={selectedSignal.strategy_id} />
                <Stat k="created" v={new Date(selectedSignal.created_ms).toLocaleTimeString()} />
              </div>
            </Panel>

            <Panel title="Delivery Status">
              <ul className="space-y-1 text-[11px] text-muted">
                <li>· State: <strong className="mono text-text">{selectedSignal.delivery?.delivery_state ?? "UNLINKED"}</strong></li>
                <li>· Outbox ID: <code className="mono text-dim">{selectedSignal.delivery?.outbox_id ?? "none"}</code></li>
                <li>· Attempts: <strong className="mono text-text">{selectedSignal.delivery?.attempts ?? 0}</strong></li>
                {selectedSignal.delivery?.error && (
                  <li className="text-down">· Error: {selectedSignal.delivery.error}</li>
                )}
              </ul>
            </Panel>

            <Panel title="Advisory Warning">
              <p className="text-[10.5px] leading-relaxed text-muted">
                AsA signals are purely advisory intelligence. AsA has no connection to venue API keys and never places orders. The human operator assumes all execution responsibility.
              </p>
            </Panel>
          </div>
        </AdaptiveDrawer>
      )}
    </div>
  );
}
