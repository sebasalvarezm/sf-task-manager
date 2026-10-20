import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { addProspectToSequence, findProspectByEmail, listMailboxes, listSequences, outreachRequest } from "@/lib/outreach";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One-off probe of the Outreach API path the sequence pipeline depends on.
 *
 * Learned so far: a manual email step creates no draft mailing, and a mailing
 * cannot be created with sequence, sequenceState or sequenceStep relationships
 * (private). So the remaining door is the task Outreach creates for the manual
 * step: a mailing created against that task. This run looks for the task two
 * ways, reports the sequence state's timing, creates the mailing on the task
 * if found, and tries a standalone mailing as a fallback. Everything created
 * is removed again unless keep=1.
 *
 * GET /api/outreach/sequence-test?email=<prospect email>&sequence=<sequence name>[&keep=1]
 */
export async function GET(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = new URL(request.url).searchParams;
  const email = q.get("email")?.trim().toLowerCase();
  const sequenceName = q.get("sequence")?.trim();
  const keep = q.get("keep") === "1";
  if (!email || !sequenceName) return NextResponse.json({ error: "Pass ?email=<prospect email>&sequence=<sequence name>" }, { status: 400 });

  const report: Record<string, unknown> = {};
  const note = (key: string, value: unknown) => {
    report[key] = value;
  };
  const text = async (res: Response) => (await res.text()).slice(0, 1500);
  const json = async (res: Response) => (res.ok ? ((await res.json()) as { data?: unknown }).data : `${res.status}: ${await text(res)}`);
  const createMailing = async (label: string, relationships: Record<string, unknown>) => {
    const sendAt = new Date(Date.now() + 7 * 86_400_000);
    sendAt.setUTCHours(10, 45, 0, 0); // 06:45 Toronto in October
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
    const body = await text(res);
    note(label, { status: res.status, body });
    if (!res.ok) return null;
    try {
      return (JSON.parse(body) as { data?: { id?: string } }).data?.id ?? null;
    } catch {
      return null;
    }
  };

  let stateId: string | null = null;
  const mailingIds: string[] = [];
  try {
    const mailboxes = await listMailboxes();
    const mailbox = mailboxes.find((m) => m.email.toLowerCase() === "sebastian@valstonecorp.com") ?? mailboxes[0];
    note("mailbox", mailbox ?? null);
    if (!mailbox) throw new Error("No mailbox found on the Outreach connection.");

    const sequences = await listSequences();
    const sequence = sequences.find((s) => s.name.trim().toLowerCase() === sequenceName.toLowerCase());
    if (!sequence) throw new Error(`No sequence named "${sequenceName}".`);
    note("sequence", sequence);
    note("sequenceSettings", await json(await outreachRequest(`/sequences/${sequence.id}?fields[sequence]=scheduleIntervalType,sequenceType,maxActivations,enabled`)));

    const prospect = await findProspectByEmail(email);
    if (!prospect) throw new Error("Prospect not found in Outreach; use the email of an existing prospect.");
    note("prospect", prospect);

    // Any tasks already on the prospect before we enrol, to tell old from new.
    const before = await outreachRequest(`/tasks?filter[prospect][id]=${prospect.id}&page[size]=20&fields[task]=taskType,state,action,dueAt,createdAt`);
    const beforeData = await json(before);
    const beforeIds = new Set(Array.isArray(beforeData) ? (beforeData as Array<{ id: string }>).map((t) => t.id) : []);
    note("tasksBefore", Array.isArray(beforeData) ? beforeIds.size : beforeData);

    const state = await addProspectToSequence({ prospectId: prospect.id, sequenceId: sequence.id, mailboxId: mailbox.id });
    stateId = state.id;
    note("sequenceState", state);
    note("stateRightAfter", await json(await outreachRequest(`/sequenceStates/${state.id}?fields[sequenceState]=state,activeAt,createdAt,errorReason`)));

    // Look for the manual step's task, two ways, for up to ~45 seconds.
    let task: { id: string; attributes?: Record<string, unknown> } | null = null;
    for (let attempt = 0; attempt < 15 && !task; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
      const byState = await outreachRequest(`/tasks?filter[sequenceState][id]=${state.id}&page[size]=5&fields[task]=taskType,state,action,dueAt,createdAt,subject`);
      if (byState.ok) {
        const body = (await byState.json()) as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> };
        task = body.data?.[0] ?? null;
      } else {
        note("tasksByStateError", await text(byState));
      }
      if (!task) {
        const byProspect = await outreachRequest(`/tasks?filter[prospect][id]=${prospect.id}&sort=-createdAt&page[size]=10&fields[task]=taskType,state,action,dueAt,createdAt,subject`);
        if (byProspect.ok) {
          const body = (await byProspect.json()) as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> };
          task = (body.data ?? []).find((t) => !beforeIds.has(t.id)) ?? null;
          if (attempt === 14) note("tasksByProspectLast", body.data ?? []);
        } else {
          note("tasksByProspectError", await text(byProspect));
        }
      }
    }
    note("task", task);
    note("stateAfterWait", await json(await outreachRequest(`/sequenceStates/${state.id}?fields[sequenceState]=state,activeAt,errorReason`)));

    if (task) {
      const id = await createMailing("createMailingOnTask", {
        prospect: { data: { type: "prospect", id: prospect.id } },
        mailbox: { data: { type: "mailbox", id: mailbox.id } },
        task: { data: { type: "task", id: task.id } },
      });
      if (id) {
        mailingIds.push(id);
        await new Promise((r) => setTimeout(r, 3000));
        note("mailingOnTaskAfter", await json(await outreachRequest(`/mailings/${id}?fields[mailing]=state,subject,scheduledAt,mailingType,errorReason`)));
        note("taskAfter", await json(await outreachRequest(`/tasks/${task.id}?fields[task]=state,completed,completedAt`)));
      }
    }

    // Fallback knowledge: can we at least schedule a plain mailing to the prospect?
    const standalone = await createMailing("createStandaloneMailing", {
      prospect: { data: { type: "prospect", id: prospect.id } },
      mailbox: { data: { type: "mailbox", id: mailbox.id } },
    });
    if (standalone) {
      mailingIds.push(standalone);
      await new Promise((r) => setTimeout(r, 2000));
      note("standaloneAfter", await json(await outreachRequest(`/mailings/${standalone}?fields[mailing]=state,subject,scheduledAt,mailingType,errorReason`)));
    }

    if (!keep) {
      for (const id of mailingIds) {
        const delM = await outreachRequest(`/mailings/${id}`, { method: "DELETE" });
        note(`cleanupDeleteMailing_${id}`, { status: delM.status, body: delM.status === 204 ? "" : await text(delM) });
        note(`mailingAfterCleanup_${id}`, await json(await outreachRequest(`/mailings/${id}?fields[mailing]=state,scheduledAt`)));
      }
      const del = await outreachRequest(`/sequenceStates/${state.id}`, { method: "DELETE" });
      stateId = null;
      note("cleanupRemovedFromSequence", { status: del.status, body: del.status === 204 ? "" : await text(del) });
    }
    return NextResponse.json(report);
  } catch (err) {
    if (!keep) {
      for (const id of mailingIds) await outreachRequest(`/mailings/${id}`, { method: "DELETE" }).catch(() => null);
      if (stateId) {
        const del = await outreachRequest(`/sequenceStates/${stateId}`, { method: "DELETE" }).catch(() => null);
        note("cleanupAfterError", del ? del.status : "failed");
      }
    }
    return NextResponse.json({ ...report, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
