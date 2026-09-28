"use client";
/** Terminal — chart-centric multi-timeframe view. */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ChartView } from "@/components/chart-view";
import { PageHead } from "@/components/chrome";
import { useLang } from "@/components/lang";

function ChartInner() {
  const { t } = useLang();
  const sp = useSearchParams();
  const urlSymbol = sp.get("symbol");
  return (
    <div>
      <PageHead
        title={t("nav", "chart")}
        sub="AsA evidence canvas — real TTT candles, 10 timeframes, native 1D; structure annotations drawn only from deterministic analysis"
        eyebrow="terminal"
      />
      {/* No remount on symbol navigation: the chart engine persists and swaps
          series data — selection state is derived from the shared store. */}
      <ChartView urlSymbol={urlSymbol} />
    </div>
  );
}

export default function ChartPage() {
  return (
    <Suspense fallback={<div className="py-10 text-center text-muted">loading chart…</div>}>
      <ChartInner />
    </Suspense>
  );
}
