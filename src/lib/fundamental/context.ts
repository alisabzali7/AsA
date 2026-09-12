/**
 * News context helper for AI/pipeline evidence: latest fundamental items
 * for a symbol from the durable store (empty string when not configured).
 */
import { getRepo } from "@/db/sqlite";

export function getNewsContext(symbol: string, limit = 3): string | null {
  try {
    const rows = getRepo().newsList({ days: 7, limit: 50 }).filter((n) => {
      try {
        return (JSON.parse(n.symbols_json) as string[]).includes(symbol);
      } catch {
        return false;
      }
    });
    if (rows.length === 0) return null;
    return rows
      .slice(0, limit)
      .map((n) => `[${new Date(n.ingested_ms).toISOString()}] ${n.title}`)
      .join("\n");
  } catch {
    return null;
  }
}
