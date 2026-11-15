import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { sfQuery } from "@/lib/sf-query";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Read-only export of the outcomes table (What gets replies), for deeper
 * analysis outside the app. Admin only. ?sender=<name> limits to one sender;
 * ?titles=1 adds each contact's Salesforce title (who the email went to).
 * Nothing is written anywhere.
 */
export async function GET(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const sender = url.searchParams.get("sender");
  const withTitles = url.searchParams.get("titles") === "1";
  try {
    const db = getSupabaseAdmin();
    const rows: Array<Record<string, unknown>> = [];
    for (let from = 0; from < 20000; from += 1000) {
      let q = db
        .from("outreach_sends")
        .select("sf_task_id, account_id, account_name, contact_email, sent_on, sent_at, sender, subject_type, country, employees, founded, industry, prior_sends, weekday, hour_et, mailing_id, sequence_name, subject, opened, replied_at, call_on, responded, quality")
        .order("sent_on", { ascending: true })
        .range(from, from + 999);
      if (sender) q = q.eq("sender", sender);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    if (withTitles) {
      const emails = Array.from(new Set(rows.map((r) => String(r.contact_email ?? "").toLowerCase()).filter((e) => /^[^'\\\s]+@[^'\\\s]+$/.test(e))));
      const titles = new Map<string, string | null>();
      for (let i = 0; i < emails.length; i += 100) {
        const recs = await sfQuery<{ Email: string | null; Title: string | null }>(
          `SELECT Email, Title FROM Contact WHERE Email IN (${emails.slice(i, i + 100).map((e) => `'${e}'`).join(",")})`,
        ).catch(() => []);
        for (const r of recs) if (r.Email) titles.set(r.Email.toLowerCase(), r.Title ?? null);
      }
      for (const r of rows) r.contact_title = titles.get(String(r.contact_email ?? "").toLowerCase()) ?? null;
    }
    return NextResponse.json({ count: rows.length, rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Export failed" }, { status: 500 });
  }
}
