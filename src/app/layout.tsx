import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LanguageProvider } from "@/components/lang";
import { AppShell } from "@/components/chrome";

export const metadata: Metadata = {
  title: "AsA — AI trading intelligence terminal",
  description: "Advisory-only crypto futures intelligence. Market truth: TTT only. AsA never executes.",
};
export const viewport: Viewport = { themeColor: "#07080a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <LanguageProvider>
          <AppShell>{children}</AppShell>
        </LanguageProvider>
      </body>
    </html>
  );
}
