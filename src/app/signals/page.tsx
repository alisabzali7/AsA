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
  /** stable failure classification; null when unclassified/legacy */
  error_kind?: string | null;
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
  /** provenance integrity of the two stored decision-identity copies */
  snapshot_identity?: { state: "AGREED" | "SINGLE_SOURCE" | "CONTRADICTION" | "ABSENT"; reason: string };
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
                  <span className="mono iso">{t("sig", "records").replace("{n}", String(items.length))}</span>
                </span>
              )}
              <button className="focus-ring btn text-[10.5px]" onClick={refresh}>
                <IconRefresh size={11} /> {t("sig", "refresh")}
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
              placeholder={t("sig", "search")}
              className="w-[200px]"
            />
            <FilterBar<DirectionFilter>
              active={dirFilter}
              onChange={setDirFilter}
              filters={[
                { id: "all", label: t("sig", "allDirections") },
                { id: "long", label: `▲ ${t("sig", "long")}` },
                { id: "short", label: `▼ ${t("sig", "short")}` },
              ]}
            />
            <FilterBar<StateFilter>
              active={stateFilter}
              onChange={setStateFilter}
              filters={[
                { id: "all", label: t("sig", "allStates") },
                { id: "published", label: t("sig", "published") },
                { id: "expired", label: t("sig", "expired") },
                { id: "rejected", label: t("sig", "rejected") },
              ]}
            />
          </div>

          {ready && (
            <span className="text-[11px] text-dim mono ms-auto">
              {t("sig", "showing").replace("{n}", String(filteredItems.length)).replace("{total}", String(items.length))}
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
          <Empty text={t("sig", "empty")} />
        )}

        {ready && items.length > 0 && filteredItems.length === 0 && (
          <Empty text={t("sig", "emptyFiltered")} />
        )}

        {/* Signal Cards */}
        <div className="flex flex-col gap-2">
          {filteredItems.map((s, i) => (
            <div key={s.id} className="rise" style={{ ["--i" as never]: i % 8 }}>
              <Panel
                title={`${s.symbol} · ${s.direction.toUpperCase()} @ ${s.timeframe}`}
                right={
                  <div className="flex items-center gap-1.5">
                    <IconButton label={t("sig", "inspect")} onClick={() => setSelectedSignal(s)}>
                      <IconInfo size={13} />
                    </IconButton>
                    <IconButton label={t("sig", "openChart")} onClick={() => handleOpenChart(s)}>
                      <IconChart size={13} />
                    </IconButton>
                    <StatusChip state={s.state} label={s.state} />
                  </div>
                }
              >
                <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                  <Badge color="var(--color-gold)">{t("sig", "score")} {typeof s.score === "number" ? s.score : "—"}</Badge>
                  <Badge>{t("sig", "strategy")} {s.strategy_id}</Badge>
                  <Badge
                    color={
                      s.delivery?.delivery_state === "SENT"
                        ? "var(--color-up)"
                        : s.delivery?.delivery_state === "FAILED" || s.delivery?.delivery_state === "DEAD"
                        ? "var(--color-down)"
                        : undefined
                    }
                  >
                    {t("sig", "delivery")} {s.delivery?.delivery_state ?? t("sig", "deliveryUnlinked")}
                  </Badge>
                  <span className="text-dim">
                    {t("sig", "created")} {new Date(s.created_ms).toLocaleString()}
                  </span>
                </div>

                <div className="mt-2 text-[10.5px] text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
                  {s.opp_id && <span>{t("sig", "opportunity")} #{s.opp_id}</span>}
                  {s.delivery?.outbox_id != null && <span>· {t("sig", "outbox")} #{s.delivery.outbox_id}</span>}
                  {s.delivery?.progress && (
                    <span>
                      · {t("sig", "chartPhoto")} {s.delivery.progress.photo_sent ? `✓ ${t("sig", "sent")}` : t("sig", "pending")} · {t("sig", "chartText")}{" "}
                      {s.delivery.progress.text_sent ? `✓ ${t("sig", "sent")}` : t("sig", "pending")}
                    </span>
                  )}
                </div>

                {s.delivery?.error && (
                  <p className="mt-1 text-[10.5px]" style={{ color: "var(--color-down)" }}>
                    {t("sig", "deliveryError")}: {s.delivery.error_kind && <code className="mono">[{s.delivery.error_kind}]</code>} {s.delivery.error}
                  </p>
                )}

                <div className="mt-2 pt-1.5 border-t hairline flex items-center justify-between text-[9.5px] text-dim">
                  <span>{t("sig", "advisory")}</span>
                  <button onClick={() => setSelectedSignal(s)} className="text-gold hover:underline font-semibold">
                    {t("sig", "inspect")} →
                  </button>
                </div>
              </Panel>
            </div>
          ))}
        </div>
      </div>

      {/* Right Column: Manual Journal Form & List */}
      <div className="flex flex-col gap-2">
        <Panel title={t("sig", "journal")}>
          <div className="flex flex-wrap gap-1.5">
            <input
              className="input w-[110px]"
              value={sym}
              onChange={(e) => setSym(e.target.value.toUpperCase())}
              aria-label={t("sig", "journalSymbol")}
              placeholder="BTCUSDT"
            />
            <select
              className="input w-[95px]"
              value={dir}
              onChange={(e) => setDir(e.target.value as "long" | "short")}
              aria-label={t("sig", "journalDirection")}
            >
              <option value="long">long</option>
              <option value="short">short</option>
            </select>
            <input
              className="input w-[80px]"
              placeholder="R mult"
              value={r}
              onChange={(e) => setR(e.target.value)}
              aria-label={t("sig", "journalR")}
            />
          </div>
          <textarea
            className="input mt-1.5 min-h-[70px] text-[12px]"
            placeholder={t("sig", "journalNotes")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="mt-2 flex items-center justify-between">
            <Button variant="gold" disabled={saving || !sym.trim()} onClick={() => void saveJournal()}>
              {saving ? t("sig", "saving") : t("sig", "save")}
            </Button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim leading-relaxed">
            {t("sig", "selfReported")}
          </p>
        </Panel>

        <Panel
          title={t("sig", "journalCount").replace("{n}", String(journal.data?.items.length ?? 0))}
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
                      title={t("sig", "delete")}
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
              <div className="py-6 text-center text-dim text-[11px]">{t("sig", "journalEmpty")}</div>
            )}
          </div>
        </Panel>
      </div>

      {/* Signal Detail Drawer */}
      {selectedSignal && (
        <AdaptiveDrawer
          title={`${t("sig", "detail")} ${selectedSignal.id}`}
          sub={`${selectedSignal.symbol} · ${selectedSignal.direction.toUpperCase()} @ ${selectedSignal.timeframe}`}
          onClose={() => setSelectedSignal(null)}
          width="520px"
          badge={<StatusBadge state={selectedSignal.state} />}
        >
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 border-b hairline pb-3">
              <Button variant="gold" className="flex-1" onClick={() => handleOpenChart(selectedSignal)}>
                <IconChart size={13} /> {t("sig", "viewTerminal")}
              </Button>
              <Button variant="default" className="flex-1" onClick={() => handleOpenAi(selectedSignal)}>
                <IconAi size={13} /> {t("sig", "askAi")}
              </Button>
            </div>

            <Panel title={t("sig", "lifecycle")}>
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <Stat k={t("sig", "lifecycleState")} v={selectedSignal.state} />
                <Stat k={t("sig", "score")} v={typeof selectedSignal.score === "number" ? selectedSignal.score : "—"} color="var(--color-gold)" />
                <Stat k={t("sig", "strategy")} v={selectedSignal.strategy_id} />
                <Stat k={t("sig", "created")} v={new Date(selectedSignal.created_ms).toLocaleTimeString()} />
              </div>
            </Panel>

            <Panel title={t("sig", "deliveryStatus")}>
              <ul className="space-y-1 text-[11px] text-muted">
                <li>· {t("sig", "delivery")}: <strong className="mono text-text">{selectedSignal.delivery?.delivery_state ?? t("sig", "deliveryUnlinked")}</strong></li>
                <li>· {t("sig", "outboxId")}: <code className="mono text-dim">{selectedSignal.delivery?.outbox_id ?? "none"}</code></li>
                <li>· {t("sig", "attempts")}: <strong className="mono text-text">{selectedSignal.delivery?.attempts ?? 0}</strong></li>
                {selectedSignal.delivery?.error && (
                  <li className="text-down">
                    · {t("sig", "deliveryError")}: {selectedSignal.delivery.error_kind && <code className="mono">{selectedSignal.delivery.error_kind}</code>} {selectedSignal.delivery.error}
                  </li>
                )}
                {selectedSignal.snapshot_identity && ["CONTRADICTION", "SINGLE_SOURCE"].includes(selectedSignal.snapshot_identity.state) && (
                  <li className="text-down">· {t("sig", "provenanceWarning")}: {selectedSignal.snapshot_identity.reason}</li>
                )}
              </ul>
            </Panel>

            <Panel title={t("sig", "advisory")}>
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
