"use client";
/** Market — the live board over the DYNAMIC TTT universe (discovered at runtime). */
import { useRouter } from "next/navigation";
import { useLang } from "@/components/lang";
import { MarketBoard } from "@/components/market-board";
import { PageHead } from "@/components/chrome";

export default function MarketPage() {
  const { t } = useLang();
  const router = useRouter();
  return (
    <div>
      <PageHead title={t("nav", "market")} sub="48 symbols · TTT only · live every ~7s" />
      <MarketBoard onFocus={(s) => router.push(`/chart?symbol=${s}`)} />
    </div>
  );
}
