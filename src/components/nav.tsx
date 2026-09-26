/**
 * ONE navigation source for header rail, mobile bottom nav, More sheet and the
 * command palette. Groups are structural (information architecture), not CSS.
 */
import type { ComponentType } from "react";
import {
  IconCommandCenter, IconMarket, IconChart, IconOpportunity, IconSignal,
  IconMind, IconAi, IconClone, IconBacktest, IconLab, IconBrain, IconNews,
  IconSystem, IconSettings,
} from "./icons";

export interface NavItem {
  href: string;
  key: string;
  en: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}
export interface NavGroup { id: string; label: string; labelFa: string; items: NavItem[] }

/** bottom nav = the highest-value thumb-reach routes; the rest live in More. */
export const MOBILE_PRIMARY = ["/", "/market", "/chart", "/opportunities", "/ai-clone"];

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "primary",
    label: "Intelligence",
    labelFa: "هوش بازار",
    items: [
      { href: "/", key: "dashboard", en: "Command Center", icon: IconCommandCenter },
      { href: "/market", key: "market", en: "Market", icon: IconMarket },
      { href: "/chart", key: "chart", en: "Terminal", icon: IconChart },
      { href: "/opportunities", key: "opportunities", en: "Opportunities", icon: IconOpportunity },
      { href: "/signals", key: "signals", en: "Signals", icon: IconSignal },
    ],
  },
  {
    id: "decision",
    label: "Decision",
    labelFa: "تصمیم",
    items: [
      { href: "/psychology", key: "psychology", en: "Psychology", icon: IconMind },
      { href: "/ai", key: "ai_analysis", en: "AI Analysis", icon: IconAi },
      { href: "/ai-clone", key: "ai", en: "AI Clone", icon: IconClone },
    ],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    labelFa: "دانش",
    items: [
      { href: "/brain", key: "brain", en: "Brain", icon: IconBrain },
      { href: "/backtest", key: "backtest", en: "Backtest", icon: IconBacktest },
      { href: "/research", key: "research", en: "Research", icon: IconLab },
      { href: "/fundamental", key: "fundamental", en: "Fundamental", icon: IconNews },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    labelFa: "عملیات",
    items: [
      { href: "/system", key: "system", en: "System", icon: IconSystem },
      { href: "/settings", key: "settings", en: "Settings", icon: IconSettings },
    ],
  },
];

export const NAV: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/* recent-destination memory (device-owned, capped, palette surfaces it) */
const RECENT_KEY = "asa-recents";

export function recordRecent(href: string): void {
  try {
    const cur = readRecents().filter((h) => h !== href);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([href, ...cur].slice(0, 6)));
  } catch { /* private mode */ }
}

export function readRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as unknown;
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
