/** DELETE /api/signals/journal/[id] — guarded mutation. */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { guardMutation } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  getRepo().journalDelete(n);
  return NextResponse.json({ ok: true, deleted: n });
}
