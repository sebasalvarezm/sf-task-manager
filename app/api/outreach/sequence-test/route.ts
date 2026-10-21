import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { addProspectToSequence, findProspectByEmail, listMailboxes, listSequences, outreachRequest } from "@/lib/outreach";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One-off probe of the Outreach API path the sequence pipeline depends on.
 *
 * Learned so far: a manual email step creates no draft mailing; a mailing
 * cannot carry sequence/sequenceState/sequenceStep relationships (private); a
 * sequence state stays "pending" outside the sequence schedule, so the manual
 * step's task only appears once the schedule activates it; a standalone
 * mailing (prospect + mailbox + subject/body/scheduledAt) is accepted and comes
 * back "drafted".
 *
 * Two-part run:
 *   1. GET ...?email=<prospect>&sequence=<name>&keep=1
 *      Enrols and leaves the state in place. Returns stateId.
 *   2. GET ...?continue=<stateId>  (during sequence schedule hours)
 *      Finds the task, creates a mailing on it, reads back the mailing and
 *      task, re-tests a standalone mailing, then removes everything.
 */
export async function GET(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = new URL(request.url).searchParams;
  const report: Record<string, unknown> = {};
  const note = (key: string, value: unknown) => {
    report[key] = value;
  };
  const text = async (res: Response) => (await res.text()).slice(0, 1500);
  const json = async (res: Response) => (res.ok ? ((await res.json()) as { data?: unknown }).data : `${res.status}: ${await text(res)}`);
  const sendAt = new Date(Date.now() + 7 * 86_400_000);
  sendAt.setUTCHours(10, 45, 0, 0);
  const createMailing = async (label: string, relationships: Record<string, unknown>) => {
    const res = await outreachRequest(`/mailings`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "mailing",
          attributes: { subject: "API test (ignore)", bodyHtml: "<p>API test body. Ignore.</p>", scheduledAt: sendAt.toISOString() },
          relationships,
        },
      }),
    });
    const full = await res.text();
    let id: string | null = null;
    let state: string | null = null;
    try {
      const parsed = JSON.parse(full) as { data?: { id?: string; attributes?: { state?: string; mailingType?: string; attributableSequenceId?: number } } };
      id = parsed.data?.id ?? null;
      state = parsed.data?.attributes?.state ?? null;
      note(label, { status: res.status, id, state, mailingType: parsed.data?.attributes?.mailingType, attributableSequenceId: parsed.data?.attributes?.attributableSequenceId });
    } catch {
      note(label, { status: res.status, id: null, body: full.slice(0, 1500) });
    }
    return id;
  };
  const mailingState = async (id: string) => json(await outreachRequest(`/mailings/${id}?fields[mailing]=state,subject,scheduledAt,mailingType,errorReason,deliveredAt`));

  const mailboxes = await listMailboxes();
  const mailbox = mailboxes.find((m) => m.email.toLowerCase() === "sebastian@valstonecorp.com") ?? mailboxes[0];
  if (!mailbox) return NextResponse.json({ error: "No mailbox on the Outreach connection." }, { status: 500 });

  // ── Part 3: inspect and delete mailings left behind ──────────────────────
  const mailingParam = q.get("mailing");
  if (mailingParam) {
    for (const id of mailingParam.split(",").map((x) => x.trim()).filter(Boolean)) {
      note(`mailing_${id}_before`, await mailingState(id));
      if (q.get("keep") !== "1") {
        const del = await outreachRequest(`/mailings/${id}`, { method: "DELETE" });
        note(`mailing_${id}_delete`, { status: del.status, body: del.status === 204 ? "" : await text(del) });
        note(`mailing_${id}_after`, await mailingState(id));
      }
    }
    return NextResponse.json(report);
  }

  // ── Part 2: continue a kept enrolment ────────────────────────────────────
  const continueId = q.get("continue");
  if (continueId) {
    const mailingIds: string[] = [];
    try {
      // No sparse fieldset here: it drops the relationships, and the prospect link is the point.
      const stateRes = await outreachRequest(`/sequenceStates/${continueId}`);
      if (!stateRes.ok) return NextResponse.json({ error: `State ${continueId}: ${await text(stateRes)}` }, { status: 500 });
      const stateBody = (await stateRes.json()) as { data: { attributes?: Record<string, unknown>; relationships?: { prospect?: { data?: { id?: string } } } } };
      const prospectId = stateBody.data.relationships?.prospect?.data?.id ?? null;
      const a = stateBody.data.attributes ?? {};
      note("state", { state: a.state, activeAt: a.activeAt, errorReason: a.errorReason, createdAt: a.createdAt });
      note("prospectId", prospectId);
      if (!prospectId) throw new Error("State has no prospect.");

      const tasksRes = await outreachRequest(`/tasks?filter[sequenceState][id]=${continueId}&page[size]=5&fields[task]=taskType,state,action,dueAt,createdAt,subject,completed`);
      const tasks = (await json(tasksRes)) as Array<{ id: string; attributes?: Record<string, unknown> }> | string;
      note("tasks", tasks);
      const task = Array.isArray(tasks) ? tasks.find((t) => t.attributes?.taskType === "manual_email") ?? tasks[0] : null;

      if (task) {
        const onTask = await createMailing("createMailingOnTask", {
          prospect: { data: { type: "prospect", id: prospectId } },
          mailbox: { data: { type: "mailbox", id: mailbox.id } },
          task: { data: { type: "task", id: task.id } },
        });
        if (onTask) {
          mailingIds.push(onTask);
          await new Promise((r) => setTimeout(r, 12000));
          note("mailingOnTaskAfter12s", await mailingState(onTask));
          note("taskAfter", await json(await outreachRequest(`/tasks/${task.id}?fields[task]=state,completed,completedAt`)));
          note("stateAfterMailing", await json(await outreachRequest(`/sequenceStates/${continueId}?fields[sequenceState]=state,activeAt,deliverCount`)));
        }
      } else {
        note("taskMissing", "No task on this state yet. Is the state active (see state.state) and the sequence schedule open right now?");
      }

      const standalone = await createMailing("createStandaloneMailing", {
        prospect: { data: { type: "prospect", id: prospectId } },
        mailbox: { data: { type: "mailbox", id: mailbox.id } },
      });
      if (standalone) {
        mailingIds.push(standalone);
        await new Promise((r) => setTimeout(r, 15000));
        note("standaloneAfter15s", await mailingState(standalone));
        const state = (report.standaloneAfter15s as { attributes?: { state?: string } } | undefined)?.attributes?.state;
        if (state === "drafted") {
          const nudge = await outreachRequest(`/mailings/${standalone}`, { method: "PATCH", body: JSON.stringify({ data: { type: "mailing", id: standalone, attributes: { state: "scheduled" } } }) });
          note("standalonePatchStateScheduled", { status: nudge.status, body: await text(nudge) });
          note("standaloneAfterNudge", await mailingState(standalone));
        }
      }

      if (q.get("keep") !== "1") {
        for (const id of mailingIds) {
          const del = await outreachRequest(`/mailings/${id}`, { method: "DELETE" });
          note(`cleanupMailing_${id}`, { status: del.status, body: del.status === 204 ? "" : await text(del) });
        }
        const del = await outreachRequest(`/sequenceStates/${continueId}`, { method: "DELETE" });
        note("cleanupRemovedFromSequence", { status: del.status, body: del.status === 204 ? "" : await text(del) });
      }
      return NextResponse.json(report);
    } catch (err) {
      for (const id of mailingIds) await outreachRequest(`/mailings/${id}`, { method: "DELETE" }).catch(() => null);
      return NextResponse.json({ ...report, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  // ── Part 1: enrol (and keep when asked) ──────────────────────────────────
  const email = q.get("email")?.trim().toLowerCase();
  const sequenceName = q.get("sequence")?.trim();
  const keep = q.get("keep") === "1";
  if (!email || !sequenceName) return NextResponse.json({ error: "Pass ?email=<prospect email>&sequence=<sequence name>[&keep=1], or ?continue=<stateId>" }, { status: 400 });

  let stateId: string | null = null;
  try {
    const sequences = await listSequences();
    const sequence = sequences.find((s) => s.name.trim().toLowerCase() === sequenceName.toLowerCase());
    if (!sequence) throw new Error(`No sequence named "${sequenceName}".`);
    note("sequence", sequence);
    note("sequenceSettings", await json(await outreachRequest(`/sequences/${sequence.id}?fields[sequence]=scheduleIntervalType,sequenceType,enabled&include=schedule`)));

    const prospect = await findProspectByEmail(email);
    if (!prospect) throw new Error("Prospect not found in Outreach.");
    note("prospect", prospect);

    const state = await addProspectToSequence({ prospectId: prospect.id, sequenceId: sequence.id, mailboxId: mailbox.id });
    stateId = state.id;
    note("sequenceState", state);
    await new Promise((r) => setTimeout(r, 5000));
    note("stateAfter5s", await json(await outreachRequest(`/sequenceStates/${state.id}?fields[sequenceState]=state,activeAt,errorReason`)));
    note("tasks", await json(await outreachRequest(`/tasks?filter[sequenceState][id]=${state.id}&page[size]=5&fields[task]=taskType,state,dueAt,createdAt`)));

    if (keep) {
      note("next", `Kept. During the sequence's schedule hours, open ...?continue=${state.id}`);
    } else {
      const del = await outreachRequest(`/sequenceStates/${state.id}`, { method: "DELETE" });
      stateId = null;
      note("cleanupRemovedFromSequence", { status: del.status, body: del.status === 204 ? "" : await text(del) });
    }
    return NextResponse.json(report);
  } catch (err) {
    if (!keep && stateId) await outreachRequest(`/sequenceStates/${stateId}`, { method: "DELETE" }).catch(() => null);
    return NextResponse.json({ ...report, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
