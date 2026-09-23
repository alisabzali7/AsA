import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LanguageProvider } from "@/components/lang";
import { AppShell } from "@/components/chrome";
import { PwaRegistrator } from "@/components/pwa";

export const metadata: Metadata = {
  title: "AsA — AI trading intelligence terminal",
  description: "Advisory-only crypto futures intelligence. Market truth: TTT only. AsA never executes.",
  applicationName: "AsA",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AsA",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};
export const viewport: Viewport = { themeColor: "#07080a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <LanguageProvider>
          <AppShell>{children}</AppShell>
        </LanguageProvider>
        <PwaRegistrator />
      </body>
    </html>
  );
}
