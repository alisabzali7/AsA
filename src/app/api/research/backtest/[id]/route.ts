/** GET /api/research/backtest/[id] — durable job + full-lineage result. */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  const job = getRepo().backtestGet(id);
  if (!job) return NextResponse.json({ ok: false, error: "job not found" }, { status: 404 });
  return NextResponse.json({
    ok: true,
    job: { ...job, result: job.result_json ? (JSON.parse(job.result_json) as unknown) : null },
  });
}
