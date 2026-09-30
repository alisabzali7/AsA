"use client";
/** Terminal — chart-centric multi-timeframe view. */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ChartView } from "@/components/chart-view";
import { PageHead } from "@/components/chrome";
import { useLang } from "@/components/lang";
import { Skeleton } from "@/components/ui";

function ChartSkeleton() {
  return (
    <div aria-hidden>
      <div className="skeleton mb-2.5 h-6 w-64" />
      <div className="chart-frame flex h-[420px] flex-col gap-2 p-3 sm:h-[560px]">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-16" />
        </div>
        <div className="flex flex-1 gap-2">
          <div className="hidden w-10 flex-col gap-1.5 sm:flex">
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-7 w-7 rounded-md" />)}
          </div>
          <div className="skeleton flex-1 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

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
    <Suspense fallback={<ChartSkeleton />}>
      <ChartInner />
    </Suspense>
  );
}
