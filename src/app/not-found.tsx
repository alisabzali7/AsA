"use client";
/**
 * AsA 404 Not Found — cinematic utility state.
 * Truthful: states clearly that the requested route does not exist in the AsA workspace.
 */
import Link from "next/link";
import { useLang } from "@/components/lang";
import { Button, Panel } from "@/components/ui";
import { openPalette } from "@/components/chrome";
import { IconChart, IconCommandCenter, IconMarket, IconSearch, IconVoid } from "@/components/icons";

export default function NotFound() {
  const { t } = useLang();

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-4">
      <Panel className="max-w-[480px] w-full text-center p-6 space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(216,188,120,0.1)] border border-gold-3 text-gold">
          <IconVoid size={24} />
        </div>

        <div>
          <div className="eyebrow text-gold">404 · ROUTE NOT FOUND</div>
          <h1 className="text-xl font-bold mt-1 text-text">Workspace Endpoint Not Found</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            The requested surface does not exist in the AsA terminal registry. AsA routes are deterministic and strictly declared.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2 border-t hairline">
          <Link href="/" className="w-full sm:w-auto">
            <Button variant="gold" className="w-full">
              <IconCommandCenter size={13} /> Command Center
            </Button>
          </Link>
          <Link href="/chart" className="w-full sm:w-auto">
            <Button variant="default" className="w-full">
              <IconChart size={13} /> Terminal Chart
            </Button>
          </Link>
          <Button variant="ghost" onClick={openPalette} className="w-full sm:w-auto">
            <IconSearch size={13} /> ⌘K Palette
          </Button>
        </div>
      </Panel>
    </div>
  );
}
