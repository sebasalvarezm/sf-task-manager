import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { generateInMailFor, listInMailQueue } from "@/lib/inmail-queue";

export const maxDuration = 300;

/** POST { whoId } for one contact, or { all: true } for every pending one. */
export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as { whoId?: string; all?: boolean };
    if (body.whoId) {
      return NextResponse.json({ item: await generateInMailFor(body.whoId) });
    }
    if (body.all) {
      const pending = (await listInMailQueue()).filter(
        (row) => row.status === "pending" && row.e1_body && row.first_name,
      );
      const results: Array<{ whoId: string; ok: boolean; error?: string }> = [];
      // Two at a time keeps the model happy and the route well inside its limit.
      for (let i = 0; i < pending.length; i += 2) {
        const chunk = pending.slice(i, i + 2);
        const outcomes = await Promise.all(
          chunk.map(async (row) => {
            try {
              await generateInMailFor(row.who_id);
              return { whoId: row.who_id, ok: true };
            } catch (err) {
              return { whoId: row.who_id, ok: false, error: err instanceof Error ? err.message : "failed" };
            }
          }),
        );
        results.push(...outcomes);
      }
      return NextResponse.json({ results, items: await listInMailQueue() });
    }
    return NextResponse.json({ error: "Pass whoId or all" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
