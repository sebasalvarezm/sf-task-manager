import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createJob, markFailed } from "@/lib/jobs";
import { inngest } from "@/lib/inngest/client";
import { getSupabaseAdmin } from "@/lib/supabase";
import { addContactAndUse, confirmSent, getSend, rebuildForSequence, approveSend, cancelSend, chooseRestaurant, getSendSettings, listSends, recheckSend, rehookSend, rejectSend, saveSendSettings, unapproveSend, updateSend, type E1Send, type SendSettings } from "@/lib/e1-sends";
import { listSequences, type OutreachSequence } from "@/lib/outreach";
import { GROUP_SEQUENCE_NAMES, normalizeSequenceName } from "@/lib/e1-sends";

/** Only the 20 group sequences from the fixed mapping, in a stable order. */
function platformSequences(all: OutreachSequence[]): OutreachSequence[] {
  // [E] only: "[RCE] - Bulk Liquids" normalizes to the same name as "[E] - Bulk Liquids".
  const byName = new Map(all.filter((s) => s.enabled && /^\s*\[E\]/i.test(s.name)).map((s) => [normalizeSequenceName(s.name), s]));
  return Object.values(GROUP_SEQUENCE_NAMES).map((n) => byName.get(normalizeSequenceName(n))).filter((s): s is OutreachSequence => !!s);
}
import { currentWeekStart } from "@/lib/weekly-outreach";
import { isVerifyConfigured } from "@/lib/email-verify";
import { getValidCredentials } from "@/lib/token-manager";

export const dynamic = "force-dynamic";
// "rehook" runs the public-source research ladder inline: a few searches and a page read.
export const maxDuration = 300;

/** GET ?week=YYYY-MM-DD: the queue for a week, settings, sequences, and whether a job is running. */
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const week = new URL(request.url).searchParams.get("week") || currentWeekStart();
    const [items, settings, sequences, job, creds] = await Promise.all([
      listSends(week),
      getSendSettings(),
      listSequences().catch(() => []),
      runningJob(),
      getValidCredentials().catch(() => null),
    ]);
    return NextResponse.json({ week, items, settings, sequences: platformSequences(sequences), job, verifierConfigured: isVerifyConfigured(), sfInstanceUrl: creds?.instance_url ?? null });
  } catch (err) {
    return NextResponse.json({ error: friendly(err) }, { status: 500 });
  }
}

/**
 * POST { action, ... }
 *   prepare  { week? }        run the checks on this week's draft-ready E1s (creates rows as needed)
 *   recheck  { id }           re-run contact/email/sequence checks after an edit
 *   approve  { id }           mark ready to schedule
 *   reject   { id, reason? }
 *   unapprove { id }          pull an approved or failed row back to review
 *   cancel   { id }           undo a dry-run or scheduled send
 *   schedule { ids? }         schedule every approved row (or the given ones)
 *   settings { ...patch }     save settings (dryRun, sequenceMap, signatureText, reviewWithModel)
 */
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: string; id?: string; ids?: string[]; week?: string; reason?: string } & Partial<SendSettings>;
    switch (body.action) {
      case "prepare": {
        const existing = await runningJob();
        if (existing) return NextResponse.json({ jobId: existing.id, duplicate: true });
        const job = await createJob({ kind: "e1_prepare", input: { weekStart: body.week || currentWeekStart() }, label: "Send queue: checking this week's E1s", resultRoute: "/send" });
        await start(job.id, "job/e1_prepare", job.input);
        return NextResponse.json({ jobId: job.id });
      }
      case "recheck": return NextResponse.json({ item: await recheckSend(need(body.id)) });
      case "rehook": return NextResponse.json({ item: await rehookSend(need(body.id)) });
      case "add_contact": {
        const c = (body as { contact?: { firstName?: string; lastName?: string; email?: string; title?: string } }).contact ?? {};
        return NextResponse.json({ item: await addContactAndUse(need(body.id), { firstName: c.firstName ?? "", lastName: c.lastName ?? "", email: c.email ?? "", title: c.title ?? null }) });
      }
      case "approve": return NextResponse.json({ item: await approveSend(need(body.id)) });
      case "unapprove": return NextResponse.json({ item: await unapproveSend(need(body.id)) });
      case "reject": return NextResponse.json({ item: await rejectSend(need(body.id), body.reason ?? null) });
      case "cancel": return NextResponse.json({ item: await cancelSend(need(body.id)) });
      case "resume": {
        // A row waiting for step 1 whose background job never ran (e.g. Inngest
        // had not picked up a new deploy): hand it to the fill job again, sending
        // now. Safe to repeat: the fill never rewrites or resends a step 1 email
        // that is already scheduled or sent.
        const row = await getSend(need(body.id));
        if (!row || row.status !== "scheduling" || !row.outreach_state_id) return NextResponse.json({ error: "Only an email waiting for Outreach can be resumed." }, { status: 400 });
        await inngest.send({ name: "e1/fill-step", data: { id: row.id, stateId: String(row.outreach_state_id), sendAt: new Date().toISOString() } });
        return NextResponse.json({ item: await updateSend(row.id, { status_reason: "Resumed: the app is filling in step 1 and sending now." }) });
      }
      case "confirm": return NextResponse.json({ item: await confirmSent(need(body.id)) });
      case "schedule": {
        const existing = await runningJob();
        if (existing) return NextResponse.json({ jobId: existing.id, duplicate: true });
        const all = await listSends(body.week || currentWeekStart());
        const ids = (body.ids?.length ? all.filter((s) => body.ids!.includes(s.id)) : all).filter((s) => s.status === "approved").map((s) => s.id);
        if (ids.length === 0) return NextResponse.json({ error: "Nothing approved to schedule." }, { status: 400 });
        const settings = await getSendSettings();
        // sendNow: skip the planned morning/evening slots and send as soon as Outreach allows.
        const sendNow = (body as { sendNow?: boolean }).sendNow === true;
        const job = await createJob({ kind: "e1_schedule", input: { ids, sendNow }, label: `Send queue: ${settings.dryRun ? "dry run" : sendNow ? "sending now" : "scheduling"} ${ids.length} email${ids.length === 1 ? "" : "s"}`, resultRoute: "/send" });
        await start(job.id, "job/e1_schedule", job.input);
        return NextResponse.json({ jobId: job.id, count: ids.length, dryRun: settings.dryRun, manualSend: settings.manualSend });
      }
      case "settings": {
        const { action: _a, id: _i, ids: _s, week: _w, reason: _r, ...patch } = body;
        void _a; void _i; void _s; void _w; void _r;
        return NextResponse.json({ settings: await saveSendSettings(patch) });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: friendly(err) }, { status: 500 });
  }
}

/** PATCH { id, contact_id?, sequence_id?, subject?, body? }: Seb's edits. Contact and sequence ids resolve to their names. */
export async function PATCH(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as { id?: string; contact_id?: string | null; sequence_id?: string | null; subject?: string; body?: string; restaurant?: string };
    const id = need(body.id);
    const { data } = await getSupabaseAdmin().from("e1_sends").select("*").eq("id", id).maybeSingle();
    const send = data as E1Send | null;
    if (!send) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (["scheduling", "dry_run", "scheduled", "sent"].includes(send.status)) return NextResponse.json({ error: "This one is already with Outreach. Cancel it first to edit." }, { status: 409 });
    const patch: Partial<E1Send> = {};
    if (typeof body.subject === "string") patch.subject = body.subject;
    if (typeof body.body === "string") patch.body = body.body;
    if (typeof body.restaurant === "string" && body.restaurant) {
      return NextResponse.json({ item: await chooseRestaurant(id, body.restaurant) });
    }
    if (body.contact_id !== undefined) {
      const c = send.contact_options.find((o) => o.id === body.contact_id) ?? null;
      patch.contact_id = c?.id ?? null;
      patch.contact_name = c?.name ?? null;
      patch.contact_first_name = c?.firstName ?? null;
      patch.contact_last_name = c?.lastName ?? null;
      patch.contact_title = c?.title ?? null;
      patch.contact_email = c?.email ?? null;
    }
    if (body.sequence_id !== undefined) {
      const seqs = await listSequences().catch(() => []);
      const s = seqs.find((x) => String(x.id) === String(body.sequence_id)) ?? null;
      patch.sequence_id = s ? String(s.id) : null;
      patch.sequence_name = s?.name ?? null;
    }
    // An approved row that gets edited goes back to review so the change is looked at again.
    if (send.status === "approved") patch.status = "ready";
    await updateSend(id, patch);
    // A sequence from another group (or none before) rewrites the email from that group's template.
    if (patch.sequence_id) {
      const r = await rebuildForSequence(id);
      if (r.note) await updateSend(id, { status_reason: r.note });
    }
    // Any edit re-runs the cheap checks, so a filled placeholder clears its flag at once.
    const item = await recheckSend(id);
    return NextResponse.json({ item });
  } catch (err) {
    return NextResponse.json({ error: friendly(err) }, { status: 500 });
  }
}

function need(id: string | undefined): string {
  if (!id) throw new Error("Missing id");
  return id;
}

async function start(jobId: string, name: string, input: Record<string, unknown>) {
  try {
    await inngest.send({ id: jobId, name, data: { jobId, input } });
  } catch (err) {
    await markFailed(jobId, "Could not start the job. Try again.").catch(() => {});
    throw err;
  }
}

async function runningJob(): Promise<{ id: string; kind: string; status: string; progress: unknown } | null> {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data } = await getSupabaseAdmin()
    .from("jobs")
    .select("id, kind, status, progress")
    .in("kind", ["e1_prepare", "e1_schedule"])
    .in("status", ["queued", "running"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data?.[0] as { id: string; kind: string; status: string; progress: unknown } | undefined) ?? null;
}

function friendly(err: unknown): string {
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (/e1_sends|job_kind|invalid input value for enum|model_calls/.test(message) && /enum|does not exist|relation|schema cache/.test(message)) {
    return "The send queue tables are missing. Run supabase/2026-10-e1-sends.sql in the Supabase SQL editor once.";
  }
  if (message === "OUTREACH_NOT_CONNECTED") return "Outreach isn't connected.";
  if (message === "NOT_CONNECTED") return "Salesforce isn't connected.";
  return message;
}
