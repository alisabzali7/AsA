"use client";
/** Human view of server-owned immutable decision and live delivery facts. */
import { use } from "react";
import Link from "next/link";
import { usePoll } from "@/components/hooks";
import { Panel, Badge } from "@/components/ui";
interface Detail {
  ok: boolean;
  item: {
    id: string; state: string; symbol: string; timeframe: string; direction: string; opp_id: string | null;
    strategy_id: string; payload_status: string;
    payload: { thesis?: string; risk?: {verdict?: string; reasons?: string[]; numbers?: Record<string, unknown>; unenforced?: string[]}; chart_source?: Record<string, unknown>; anchor_close_ms?: number; score_semantics?: string; psychology?: unknown; portfolio?: unknown } | null;
    delivery: {delivery_state: string; outbox_id: number | null; attempts: number | null; error: string | null; progress: {photo_required: boolean; photo_sent: boolean; text_sent: boolean; photo_message_id?: number | null; text_message_id?: number | null} | null};
    lifecycle: {note: string; history: {from_state: string | null; to_state: string; changed_ms: number}[]};
  };
}
const json = (value: unknown) => JSON.stringify(value ?? "UNAVAILABLE", null, 2);
export default function SignalDetail({ params }: {params: Promise<{id:string}>}) {
  const {id} = use(params);
  const {data, loading, error, age_ms, refresh} = usePoll<Detail>(`/api/signals/${encodeURIComponent(id)}`, 15000);
  const s = data?.item;
  return <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-3">
    <div className="flex items-center justify-between"><Link href="/signals" className="text-gold underline">← Signals</Link><button className="btn" onClick={refresh}>refresh evidence</button></div>
    <h1 className="text-lg font-semibold">Decision, delivery & lifecycle</h1>
    <p className="text-xs text-muted">ADVISORY ONLY · decision ≠ delivery ≠ order. Provider acceptance is not human receipt or execution.</p>
    {loading && !data && <p role="status">Loading signal evidence…</p>}
    {error && <p role="alert" className="text-down">Signal evidence unavailable: {error}. {data && "Showing last received snapshot, not current confirmation."}</p>}
    {data && age_ms !== null && age_ms > 30000 && <p role="status">STALE — last successful refresh {Math.floor(age_ms/1000)}s ago.</p>}
    {s && <>
      <Panel title={`${s.symbol} · ${s.direction} · ${s.timeframe}`} right={<Badge>{s.state}</Badge>}>
        <p className="break-all text-xs text-muted">signal {s.id} · opportunity {s.opp_id ?? "UNLINKED"} · {s.strategy_id}</p>
        <p className="mt-2 text-sm">{s.payload?.thesis ?? "Decision payload UNAVAILABLE"}</p>
        <p className="mt-1 text-xs text-muted">{s.payload?.score_semantics ?? "Score is not a calibrated probability."}</p>
      </Panel>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <Panel title="Immutable risk decision"><p className="mb-2 text-sm">Risk {s.payload?.risk?.verdict ?? "UNAVAILABLE"}</p><pre dir="ltr" className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{json(s.payload?.risk)}</pre></Panel>
        <Panel title={`Delivery ${s.delivery.delivery_state}`}>
          <p className="text-xs">Outbox #{s.delivery.outbox_id ?? "UNLINKED"} · transport cycles {s.delivery.attempts ?? "UNKNOWN"}</p>
          <p className="mt-2 text-sm">Chart: {s.delivery.progress?.photo_sent ? "accepted" : s.delivery.progress?.photo_required ? "required / pending" : "not required (legacy)"} · Text: {s.delivery.progress?.text_sent ? "accepted" : "pending"}</p>
          <p className="mt-2 text-xs text-muted">Photo message ID: {s.delivery.progress?.photo_message_id ?? "UNKNOWN"}<br/>Text message ID: {s.delivery.progress?.text_message_id ?? "UNKNOWN"}</p>
          {s.delivery.error && <p className="mt-2 break-words text-xs text-down">{s.delivery.error}</p>}
        </Panel>
      </div>
      <Panel title="Recorded lifecycle / provenance">
        <ul className="space-y-2 text-xs">{s.lifecycle.history.map((h,i)=><li key={i}><span dir="ltr">{new Date(h.changed_ms).toISOString()}</span> · {h.from_state ?? "created"} → {h.to_state}</li>)}</ul>
        <p className="mt-2 text-xs text-muted">{s.lifecycle.note}</p>
      </Panel>
      <Panel title="Chart source / decision anchor">
        <p className="mb-2 text-xs text-muted">The chart must match this exact OHLCV fingerprint and range. Unavailable historical candles cannot be replaced with current or synthetic market data.</p>
        <pre dir="ltr" className="overflow-auto whitespace-pre-wrap break-all text-xs">{json(s.payload?.chart_source)}</pre>
        <p className="mt-2 text-xs">Anchor close: {s.payload?.anchor_close_ms ? new Date(s.payload.anchor_close_ms).toISOString() : "UNKNOWN"}</p>
        {s.opp_id && <Link className="mt-2 inline-block text-xs text-gold underline" href={`/api/charts/${encodeURIComponent(s.id)}.png`}>Open immutable chart (availability checked by server)</Link>}
      </Panel>
      <details className="text-xs"><summary className="cursor-pointer text-gold">Full server evidence (including unavailable fields)</summary><pre dir="ltr" className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all">{json(s)}</pre></details>
    </>}
  </div>;
}
