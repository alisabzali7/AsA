/**
 * AsA icon family — ONE coherent language (24px grid, 1.6 stroke, round caps,
 * geometric-terminal character). Original line work, no third-party artwork.
 * Directional icons mirror automatically in RTL via [dir=rtl]; content icons
 * (chart, brain, shield…) never mirror.
 */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCommandCenter = (p: P) => (
  <Svg {...p}><path d="M4 20V9M10 20V4M16 20v-7M21 20H3" /></Svg>
);
export const IconMarket = (p: P) => (
  <Svg {...p}><path d="M3 17l5-5 4 3 6-7M18 8h3v3" /></Svg>
);
export const IconChart = (p: P) => (
  <Svg {...p}><path d="M3 4v16h18" /><path d="M7 15v3M11 9v9M15 12v6M19 7v11" /></Svg>
);
export const IconOpportunity = (p: P) => (
  <Svg {...p}><path d="M12 3l2.4 5.4L20 9l-4 4 1 6-5-2.8L7 19l1-6-4-4 5.6-.6z" /></Svg>
);
export const IconSignal = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="2.2" /><path d="M8.5 8.5a5 5 0 000 7M15.5 15.5a5 5 0 000-7M6 6a8.5 8.5 0 000 12M18 18a8.5 8.5 0 000-12" /></Svg>
);
export const IconMind = (p: P) => (
  <Svg {...p}><path d="M9.5 4.5A3.5 3.5 0 0116 6.3a3.4 3.4 0 012 3.2c0 1-.4 1.8-1 2.4.6.7 1 1.5 1 2.4a3.5 3.5 0 01-4 3.5c-.6 1.7-2.5 2.7-4.3 2.2" /><path d="M9.5 4.5C7.6 5 6.2 6.6 6 8.5a3.3 3.3 0 00.9 2.9A3.4 3.4 0 005 14.2c.3 1.8 1.6 3.3 3.3 3.7" /><path d="M12 8v9" /></Svg>
);
export const IconStrategy = (p: P) => (
  <Svg {...p}><path d="M4 5h16M4 12h10M4 19h16" /><circle cx="18" cy="12" r="2" /></Svg>
);
export const IconRisk = (p: P) => (
  <Svg {...p}><path d="M12 3l8 3v6c0 4.5-3.2 7.4-8 9-4.8-1.6-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4.5" /></Svg>
);
export const IconAi = (p: P) => (
  <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.6 4.6l2 2M17.4 17.4l2 2M19.4 4.6l-2 2M6.6 17.4l-2 2" /></Svg>
);
export const IconClone = (p: P) => (
  <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3.8 19c.6-3 2.7-4.6 5.2-4.6s4.6 1.6 5.2 4.6" /><circle cx="16.8" cy="9.4" r="2.4" opacity=".55" /><path d="M15.4 14.2c2.3.1 4 1.6 4.6 4.2" opacity=".55" /></Svg>
);
export const IconBrain = (p: P) => (
  <Svg {...p}><path d="M12 5.2A3 3 0 006.6 7a2.8 2.8 0 00-1.9 4.4A3 3 0 006 16.4a3 3 0 006 .4zM12 5.2A3 3 0 0117.4 7a2.8 2.8 0 011.9 4.4A3 3 0 0118 16.4a3 3 0 01-6 .4z" /><path d="M12 5.2V19" opacity=".55" /></Svg>
);
export const IconLab = (p: P) => (
  <Svg {...p}><path d="M10 3v5.2L4.8 17a2.4 2.4 0 002.1 3.5h10.2a2.4 2.4 0 002.1-3.5L14 8.2V3" /><path d="M8.6 3h6.8M7.5 14h9" /></Svg>
);
export const IconBacktest = (p: P) => (
  <Svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M7 14l3-3 2.4 2L17 8.6" /><path d="M14.2 8.6H17V11.4" /></Svg>
);
export const IconNews = (p: P) => (
  <Svg {...p}><rect x="3.5" y="5" width="14" height="14" rx="2" /><path d="M17.5 9h3v8a2 2 0 01-2 2h-11" /><path d="M6.5 8.5h8M6.5 12h8M6.5 15.5h5" /></Svg>
);
export const IconSystem = (p: P) => (
  <Svg {...p}><rect x="3.5" y="4.5" width="17" height="6" rx="1.6" /><rect x="3.5" y="13.5" width="17" height="6" rx="1.6" /><path d="M7 7.5h.01M7 16.5h.01M11 7.5h4M11 16.5h4" /></Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2.8l1.2 2.3 2.5-.6.6 2.5 2.3 1.2-1.4 2.1 1.4 2.1-2.3 1.2-.6 2.5-2.5-.6L12 21.2l-1.2-2.3-2.5.6-.6-2.5-2.3-1.2L6.8 14l-1.4-2.1 2.3-1.2.6-2.5 2.5.6z" opacity=".9" /></Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}><circle cx="11" cy="11" r="6" /><path d="M15.5 15.5L20 20" /></Svg>
);
export const IconClose = (p: P) => (<Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>);
export const IconMenu = (p: P) => (<Svg {...p}><path d="M4 7h16M4 12h16M4 17h10" /></Svg>);
export const IconRefresh = (p: P) => (
  <Svg {...p}><path d="M20 12a8 8 0 11-2.3-5.6" /><path d="M20 3.5V7h-3.5" /></Svg>
);
export const IconAlert = (p: P) => (
  <Svg {...p}><path d="M12 3.8L21 19H3z" /><path d="M12 10v4M12 16.6h.01" /></Svg>
);
export const IconOffline = (p: P) => (
  <Svg {...p}><path d="M2.5 4.5l19 15" opacity=".9" /><path d="M5 12.8A7.5 7.5 0 018.6 10M12 6.2a9.6 9.6 0 016.7 2.2M9.6 16a4.6 4.6 0 015.2.4" /><circle cx="12" cy="19" r=".8" fill="currentColor" /></Svg>
);
export const IconVoid = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.2" strokeDasharray="2.6 3" /><path d="M9.5 14.5c1.6-1.1 3.4-1.1 5 0" opacity=".7" /><path d="M9 9.6h.01M15 9.6h.01" /></Svg>
);
export const IconStale = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.2" /><path d="M12 7.5V12l3 2" /></Svg>
);
export const IconPartial = (p: P) => (
  <Svg {...p}><path d="M12 3.8l8.2 15H3.8z" /><path d="M12 3.8V12l4 6.8" opacity=".55" /></Svg>
);
export const IconCheck = (p: P) => (<Svg {...p}><path d="M4.5 12.5l4.8 4.8L19.5 7" /></Svg>);
export const IconChevron = (p: P) => (
  <Svg {...p} className={p.className}><path d="M9 5l7 7-7 7" /></Svg>
);
export const IconSwap = (p: P) => (
  <Svg {...p}><path d="M7 4v13M4 14l3 3 3-3M17 20V7M14 10l3-3 3 3" /></Svg>
);
export const IconLang = (p: P) => (
  <Svg {...p}><path d="M3.5 6h8M7 4v2M9.5 6c-.3 3.4-2.6 6.2-6 7.5M5 9.8c1 2 2.7 3.5 5 4.4" /><path d="M12.5 20l4-9 4 9M13.9 17h5.2" /></Svg>
);
export const IconDensity = (p: P) => (
  <Svg {...p}><path d="M4 6h16M4 12h16M4 18h16" strokeWidth={2.4} /></Svg>
);
export const IconInfo = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.4" /><path d="M12 11v5.2M12 7.8h.01" /></Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 10-5.7-5.7L11.5 6.8" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 105.7 5.7l1.5-1.5" /></Svg>
);
export const IconZap = (p: P) => (<Svg {...p}><path d="M13 2.5L4.5 13.5H11L10 21.5l9-11.5H12z" /></Svg>);
export const IconLayers = (p: P) => (
  <Svg {...p}><path d="M12 3.5l8.5 4.3L12 12 3.5 7.8z" /><path d="M3.5 12.5L12 16.8l8.5-4.3M3.5 16.8L12 21l8.5-4.2" opacity=".7" /></Svg>
);
export const IconPulse = (p: P) => (
  <Svg {...p}><path d="M2.5 12H6l2-6 4 12 2-6h7.5" /></Svg>
);

export const IconFullscreen = (p: P) => (
  <Svg {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>
);
export const IconFullscreenExit = (p: P) => (
  <Svg {...p}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></Svg>
);
export const IconCamera = (p: P) => (
  <Svg {...p}><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" /></Svg>
);
export const IconPin = (p: P) => (
  <Svg {...p}><path d="M12 17v5M5 9l14-4-5 14-3-5z" /></Svg>
);
export const IconPinFilled = (p: P) => (
  <Svg {...p}><path d="M12 17v5M5 9l14-4-5 14-3-5z" fill="currentColor" /></Svg>
);
export const IconTrendLine = (p: P) => (
  <Svg {...p}><path d="M4 19L20 5M4 19a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM20 5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" /></Svg>
);
export const IconHorizontalLine = (p: P) => (
  <Svg {...p}><path d="M3 12h18M12 12a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" /></Svg>
);
export const IconVerticalLine = (p: P) => (
  <Svg {...p}><path d="M12 3v18M12 12a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" /></Svg>
);
export const IconRay = (p: P) => (
  <Svg {...p}><path d="M4 18L19 7M19 7h-5M19 7v5M4 18a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" /></Svg>
);
export const IconRectangle = (p: P) => (
  <Svg {...p}><rect x="4" y="5" width="16" height="14" rx="2" /></Svg>
);
export const IconRuler = (p: P) => (
  <Svg {...p}><path d="M4 18l14-14M7 9l2 2M10 6l2 2M13 3l2 2M10 12l2 2M13 15l2 2" /></Svg>
);
export const IconFibonacci = (p: P) => (
  <Svg {...p}><path d="M3 5h18M3 9h18M3 12h18M3 15h18M3 19h18" opacity=".8" /><path d="M5 19L19 5" strokeWidth={2} /></Svg>
);
export const IconText = (p: P) => (
  <Svg {...p}><path d="M4 7V4h16v3M12 4v16M8 20h8" /></Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" /></Svg>
);
export const IconEye = (p: P) => (
  <Svg {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></Svg>
);
export const IconEyeOff = (p: P) => (
  <Svg {...p}><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22M9.88 9.88a3 3 0 104.24 4.24" /></Svg>
);
export const IconCrosshair = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></Svg>
);
export const IconCursor = (p: P) => (
  <Svg {...p}><path d="M4 4l7 17 2.5-6.5L20 12z" /></Svg>
);
export const IconSliders = (p: P) => (
  <Svg {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></Svg>
);
export const IconFilter = (p: P) => (
  <Svg {...p}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></Svg>
);
export const IconSparkles = (p: P) => (
  <Svg {...p}><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3zM19 17l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3zM5 19l.6 1.8 1.8.6-1.8.6L5 24l-.6-1.8L2.6 22l1.8-.6L5 19z" /></Svg>
);
export const IconTrendingUp = (p: P) => (
  <Svg {...p}><path d="M23 6l-9.5 9.5-5-5L1 18" /><path d="M17 6h6v6" /></Svg>
);
export const IconTrendingDown = (p: P) => (
  <Svg {...p}><path d="M23 18l-9.5-9.5-5 5L1 6" /><path d="M17 18h6v-6" /></Svg>
);
