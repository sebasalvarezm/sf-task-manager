import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { addProspectToSequence, findProspectByEmail, listMailboxes, listSequences, outreachRequest } from "@/lib/outreach";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One-off probe of the Outreach API path the sequence pipeline depends on.
 *
 * A manual email step does not create a draft mailing; it creates a task, and
 * the outbox draft is that task. So the pipeline must create the mailing itself,
 * tied to the task and the step, with the subject, body and send time. This
 * probe does exactly that for one prospect in one sequence, reports every
 * step, and (by default) removes the prospect and the mailing again so nothing
 * goes out.
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

  let stateId: string | null = null;
  let mailingId: string | null = null;
  try {
    const mailboxes = await listMailboxes();
    const mailbox = mailboxes.find((m) => m.email.toLowerCase() === "sebastian@valstonecorp.com") ?? mailboxes[0];
    note("mailbox", mailbox ?? null);
    if (!mailbox) throw new Error("No mailbox found on the Outreach connection.");

    const sequences = await listSequences();
    const sequence = sequences.find((s) => s.name.trim().toLowerCase() === sequenceName.toLowerCase());
    note("sequence", sequence ?? { error: `No sequence named "${sequenceName}"`, names: sequences.map((s) => s.name) });
    if (!sequence) throw new Error("Sequence not found.");

    const stepRes = await outreachRequest(`/sequenceSteps?filter[sequence][id]=${sequence.id}&sort=order&page[size]=3&fields[sequenceStep]=order,stepType,interval`);
    const steps = (await json(stepRes)) as Array<{ id: string; attributes?: Record<string, unknown> }> | string;
    note("steps", steps);
    const step1 = Array.isArray(steps) ? steps[0] : null;
    if (!step1) throw new Error("Could not read the sequence steps (scope sequenceSteps.read missing? Reconnect Outreach).");

    const prospect = await findProspectByEmail(email);
    note("prospect", prospect);
    if (!prospect) throw new Error("Prospect not found in Outreach; use the email of an existing prospect.");

    const state = await addProspectToSequence({ prospectId: prospect.id, sequenceId: sequence.id, mailboxId: mailbox.id });
    stateId = state.id;
    note("sequenceState", state);

    // The manual step's task. Outreach creates it within a few seconds.
    let task: { id: string; attributes?: Record<string, unknown> } | null = null;
    for (let attempt = 0; attempt < 8 && !task; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
      const t = await outreachRequest(`/tasks?filter[sequenceState][id]=${state.id}&page[size]=5&fields[task]=taskType,state,action,dueAt,subject,completed`);
      if (!t.ok) {
        note("tasksQueryError", await text(t));
        break;
      }
      const body = (await t.json()) as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> };
      task = body.data?.[0] ?? null;
    }
    note("task", task);

    const sendAt = new Date(Date.now() + 7 * 86_400_000);
    sendAt.setUTCHours(10, 45, 0, 0); // 06:45 Toronto in October
    const relationships: Record<string, unknown> = {
      prospect: { data: { type: "prospect", id: prospect.id } },
      mailbox: { data: { type: "mailbox", id: mailbox.id } },
      sequence: { data: { type: "sequence", id: sequence.id } },
      sequenceState: { data: { type: "sequenceState", id: state.id } },
      sequenceStep: { data: { type: "sequenceStep", id: step1.id } },
      ...(task ? { task: { data: { type: "task", id: task.id } } } : {}),
    };
    const create = await outreachRequest(`/mailings`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "mailing",
          attributes: { subject: "API test (ignore)", bodyHtml: "<p>API test body. Ignore.</p>", scheduledAt: sendAt.toISOString(), mailingType: "sequence" },
          relationships,
        },
      }),
    });
    const createBody = await text(create);
    note("createMailing", { status: create.status, body: createBody });
    if (create.ok) {
      try {
        mailingId = (JSON.parse(createBody) as { data?: { id?: string } }).data?.id ?? null;
      } catch {
        mailingId = null;
      }
    } else if (task) {
      // Without the task link, in case Outreach refuses that relationship.
      delete relationships.task;
      const retry = await outreachRequest(`/mailings`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "mailing",
            attributes: { subject: "API test (ignore)", bodyHtml: "<p>API test body. Ignore.</p>", scheduledAt: sendAt.toISOString(), mailingType: "sequence" },
            relationships,
          },
        }),
      });
      const retryBody = await text(retry);
      note("createMailingWithoutTask", { status: retry.status, body: retryBody });
      if (retry.ok) {
        try {
          mailingId = (JSON.parse(retryBody) as { data?: { id?: string } }).data?.id ?? null;
        } catch {
          mailingId = null;
        }
      }
    }

    if (mailingId) {
      await new Promise((r) => setTimeout(r, 3000));
      note("mailingAfterCreate", await json(await outreachRequest(`/mailings/${mailingId}?fields[mailing]=state,subject,scheduledAt,mailingType,errorReason`)));
      if (task) note("taskAfterCreate", await json(await outreachRequest(`/tasks/${task.id}?fields[task]=state,completed,completedAt`)));
      note("stateAfterCreate", await json(await outreachRequest(`/sequenceStates/${state.id}?fields[sequenceState]=state,activeAt,deliverCount`)));
    }

    if (!keep) {
      if (mailingId) {
        const delM = await outreachRequest(`/mailings/${mailingId}`, { method: "DELETE" });
        note("cleanupDeleteMailing", { status: delM.status, body: delM.status === 204 ? "" : await text(delM) });
        note("mailingAfterCleanup", await json(await outreachRequest(`/mailings/${mailingId}?fields[mailing]=state,scheduledAt`)));
      }
      const del = await outreachRequest(`/sequenceStates/${state.id}`, { method: "DELETE" });
      stateId = null;
      note("cleanupRemovedFromSequence", { status: del.status, body: del.status === 204 ? "" : await text(del) });
    }
    return NextResponse.json(report);
  } catch (err) {
    // Never leave a test enrolment behind on a failure.
    if (!keep && stateId) {
      const del = await outreachRequest(`/sequenceStates/${stateId}`, { method: "DELETE" }).catch(() => null);
      note("cleanupAfterError", del ? del.status : "failed");
    }
    return NextResponse.json({ ...report, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
