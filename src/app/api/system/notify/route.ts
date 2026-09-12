/**
 * GET  /api/system/notify — measured notifier state + durable outbox counts.
 * POST /api/system/notify {action:"test"|"drain"} — operator actions.
 *
 * "test" enqueues ONE advisory row and drains the outbox, so the operator can
 * prove delivery end-to-end. It is advisory text only: no execution buttons,
 * no order/position content, ever. When TELEGRAM_DRY_RUN=1 the row is created
 * and stays QUEUED — the response says so explicitly rather than pretending
 * a send happened.
 */
import { NextResponse } from "next/server";
import { guardMutation, readBody } from "@/lib/api-common";
import { getRepo } from "@/db/sqlite";
import { telegramStateLive, drainOutbox, formatSignalText, type TelegramSignalPayload } from "@/lib/notify/telegram";
import { TELEGRAM_DRY_RUN } from "@/lib/env";

export const dynamic = "force-dynamic";

function outboxCounts(): Record<string, number> {
  const rows = getRepo().outboxList("ALL", 500);
  const counts: Record<string, number> = { QUEUED: 0, SENT: 0, FAILED: 0, DEAD: 0 };
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  return counts;
}

export async function GET(): Promise<NextResponse> {
  const telegram = await telegramStateLive();
  return NextResponse.json({
    ok: true,
    telegram,
    outbox: outboxCounts(),
    note: "state ONLINE means the provider answered getMe; DEGRADED with dry_run means nothing is sent.",
    ts: Date.now(),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const action = typeof body.action === "string" ? body.action : "";

  if (action !== "test" && action !== "drain") {
    return NextResponse.json({ ok: false, error: 'action must be "test" or "drain"' }, { status: 400 });
  }

  const repo = getRepo();
  let enqueued: number | null = null;
  if (action === "test") {
    const payload: TelegramSignalPayload = {
      kind: "system",
      thesis:
        "AsA notifier connectivity test. This is an advisory-only channel: AsA never executes, never places orders, and never manages positions. Human decides.",
      generated_at_ms: Date.now(),
    };
    enqueued = repo.outboxEnqueue("system", payload);
    void formatSignalText(payload); // shape check on the exact text that would be sent
  }

  const drained = await drainOutbox();
  const telegram = await telegramStateLive();
  return NextResponse.json({
    ok: true,
    action,
    enqueued_row_id: enqueued,
    drained,
    dry_run: TELEGRAM_DRY_RUN,
    delivery: TELEGRAM_DRY_RUN
      ? "DRY_RUN=1 — row persisted and left QUEUED; nothing was sent to Telegram"
      : drained.sent > 0
        ? "provider accepted at least one row"
        : "no row was accepted by the provider (see outbox errors)",
    telegram,
    outbox: outboxCounts(),
    ts: Date.now(),
  });
}
