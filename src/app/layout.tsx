import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
/* unicode-range split files: latin subsets download only for LTR, arabic only
   for Persian text — one @font-face list, zero wasted bytes either way */
import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/500.css";
import "@fontsource/vazirmatn/600.css";
import "@fontsource/vazirmatn/700.css";
import "./globals.css";
import { LanguageProvider } from "@/components/lang";
import { AppShell } from "@/components/chrome";
import { CommandPalette } from "@/components/palette";
import { ToastProvider } from "@/components/toast";
import { PwaRegistrator } from "@/components/pwa";

export const metadata: Metadata = {
  title: "AsA — Intelligence Terminal",
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
export const viewport: Viewport = { themeColor: "#06070a", width: "device-width", initialScale: 1 };

/** Pre-paint language and theme restore: a saved Persian preference or theme
 *  must not first render wrong frame. Runs before hydration. */
const LANG_BOOT = `try{var d=document.documentElement;var l=localStorage.getItem("asa-lang");if(l==="fa"){d.lang="fa";d.dir="rtl";}var q=localStorage.getItem("asa-density");if(q==="compact")d.dataset.density="compact";var m=localStorage.getItem("asa-motion");if(m==="reduced")d.dataset.motion="reduced";var r=localStorage.getItem("asa-rail");if(r==="compact")d.dataset.rail="compact";var th=localStorage.getItem("asa-theme");if(th==="light"){d.dataset.theme="light";d.classList.add("light");}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: LANG_BOOT }} />
      </head>
      <body>
        <LanguageProvider>
          <ToastProvider>
            <AppShell>{children}</AppShell>
            <CommandPalette />
          </ToastProvider>
          <PwaRegistrator />
        </LanguageProvider>
      </body>
    </html>
  );
}
