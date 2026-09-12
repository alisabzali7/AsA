"use client";
/** Fundamental — news with 30d rolling retention, clearly auxiliary. */
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Badge, Empty, Panel } from "@/components/ui";

interface NewsShape {
  ok: boolean;
  state: { state: string; reason?: string; last_poll_ms: number | null; items_stored: number };
  connectors: { id: string; name: string; configured: boolean; state: { state: string; reason?: string } }[];
  items: { id: number; source: string; source_type: string; url: string; title: string; summary: string; impact: string; related_symbols: string[]; published_at_ms: number | null; ingested_at_ms: number }[];
}

export default function FundamentalPage() {
  const { t } = useLang();
  const d = usePoll<NewsShape>("/api/fundamental/news?days=30&limit=200", 30_000);
  const state = d.data?.state;
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[15px] font-semibold">{t("nav", "fundamental")}</h1>
      <Panel title="connector state">
        {d.data?.connectors.map((c) => (
          <div key={c.id} className="flex items-center justify-between py-1 text-[12px]">
            <span>{c.name} <span className="text-dim">({c.id})</span></span>
            <span className="flex items-center gap-2">
              <Badge color={c.configured ? "#3fb68b" : "#5d616b"}>{c.configured ? "CONFIGURED" : "NOT CONFIGURED"}</Badge>
              <span className="text-[10px] text-dim">{c.state.reason ?? c.state.state}</span>
            </span>
          </div>
        ))}
        <p className="mt-1.5 text-[10px] text-dim">
          Rolling 30-day retention with auditable runs · append-only inside the window · auxiliiary news is never market price truth.
        </p>
      </Panel>
      {state && state.state === "NOT_CONFIGURED" && (
        <Empty text={`No news connector configured — nothing is invented. Set NEWS_RSS_URL in .env and restart to enable the generic RSS connector (poll every 30 min). Items: ${state.items_stored}`} />
      )}
      <div className="flex flex-col gap-1.5">
        {d.data?.items.map((n) => (
          <Panel key={n.id} className="py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {n.url ? <a className="text-[12.5px] font-semibold hover:text-gold focus-ring rounded" href={n.url} target="_blank" rel="noreferrer">{n.title}</a> : <span className="text-[12.5px] font-semibold">{n.title}</span>}
              <Badge color="#d6a24a">{n.impact}</Badge>
              <Badge>{n.source_type}</Badge>
            </div>
            {n.summary && <p className="mt-1 text-[11px] leading-relaxed text-muted">{n.summary.slice(0, 400)}</p>}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9.5px] text-dim">
              <span>source {n.source}</span>
              {n.published_at_ms && <span>· published {new Date(n.published_at_ms).toISOString().slice(0, 16)}</span>}
              <span>· ingested {new Date(n.ingested_at_ms).toISOString().slice(0, 16)}</span>
              {n.related_symbols.map((s) => <Badge key={s} color="#8b8f99">{s}</Badge>)}
            </div>
          </Panel>
        ))}
        {d.data && d.data.items.length > 0 && state && (
          <p className="text-center text-[10px] text-dim">showing newest {d.data.items.length} of {state.items_stored} stored items (30d window)</p>
        )}
      </div>
    </div>
  );
}
