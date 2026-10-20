import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { addProspectToSequence, findProspectByEmail, listMailboxes, listSequences, outreachRequest } from "@/lib/outreach";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One-off probe of the Outreach API path the sequence pipeline depends on:
 * add a prospect to a sequence whose step 1 is a manual email, find the draft
 * mailing Outreach creates, rewrite its subject and body, give it a send time,
 * then (by default) remove the prospect from the sequence again so nothing
 * goes out. Every step is reported so we can see exactly what Outreach allows.
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

  try {
    const mailboxes = await listMailboxes();
    const mailbox = mailboxes.find((m) => m.email.toLowerCase() === "sebastian@valstonecorp.com") ?? mailboxes[0];
    note("mailbox", mailbox ?? null);
    if (!mailbox) throw new Error("No mailbox found on the Outreach connection.");

    const sequences = await listSequences();
    const sequence = sequences.find((s) => s.name.trim().toLowerCase() === sequenceName.toLowerCase());
    note("sequence", sequence ?? { error: `No sequence named "${sequenceName}"`, names: sequences.map((s) => s.name) });
    if (!sequence) throw new Error("Sequence not found.");

    const prospect = await findProspectByEmail(email);
    note("prospect", prospect);
    if (!prospect) throw new Error("Prospect not found in Outreach; use the email of an existing prospect.");

    const existing = await outreachRequest(`/sequenceStates?filter[prospect][id]=${prospect.id}&filter[sequence][id]=${sequence.id}&page[size]=10`);
    note("existingStatesInThisSequence", existing.ok ? ((await existing.json()) as { data?: unknown[] }).data ?? [] : await text(existing));

    const state = await addProspectToSequence({ prospectId: prospect.id, sequenceId: sequence.id, mailboxId: mailbox.id });
    note("sequenceState", state);

    // The manual step shows up as a task and (usually) a drafted mailing. Poll for both.
    let mailing: { id: string; attributes?: Record<string, unknown> } | null = null;
    let tasks: unknown = null;
    for (let attempt = 0; attempt < 10 && !mailing; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
      const m = await outreachRequest(`/mailings?filter[sequenceState][id]=${state.id}&sort=-createdAt&page[size]=5&fields[mailing]=state,subject,scheduledAt,mailingType,bodyHtml,createdAt`);
      if (m.ok) {
        const body = (await m.json()) as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> };
        mailing = body.data?.[0] ?? null;
      } else {
        note(`mailingsQueryError_${attempt}`, await text(m));
      }
      const t = await outreachRequest(`/tasks?filter[sequenceState][id]=${state.id}&page[size]=5&fields[task]=taskType,state,action,dueAt,subject`);
      tasks = t.ok ? ((await t.json()) as { data?: unknown[] }).data ?? [] : await text(t);
    }
    note("tasks", tasks);
    note("draftMailing", mailing ? { id: mailing.id, ...mailing.attributes, bodyHtml: String(mailing.attributes?.bodyHtml ?? "").slice(0, 300) } : null);

    if (mailing) {
      const sendAt = new Date(Date.now() + 7 * 86_400_000);
      sendAt.setUTCHours(10, 45, 0, 0); // 06:45 Toronto in October
      const patch = await outreachRequest(`/mailings/${mailing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "mailing",
            id: mailing.id,
            attributes: { subject: "API test (ignore)", bodyHtml: "<p>API test body. Ignore.</p>", scheduledAt: sendAt.toISOString() },
          },
        }),
      });
      note("patchSubjectBodySchedule", { status: patch.status, body: await text(patch) });

      if (!patch.ok) {
        // Try the two halves separately so we learn which part Outreach refuses.
        const p1 = await outreachRequest(`/mailings/${mailing.id}`, { method: "PATCH", body: JSON.stringify({ data: { type: "mailing", id: mailing.id, attributes: { subject: "API test (ignore)", bodyHtml: "<p>API test body. Ignore.</p>" } } }) });
        note("patchSubjectBodyOnly", { status: p1.status, body: await text(p1) });
        const p2 = await outreachRequest(`/mailings/${mailing.id}`, { method: "PATCH", body: JSON.stringify({ data: { type: "mailing", id: mailing.id, attributes: { scheduledAt: sendAt.toISOString() } } }) });
        note("patchScheduleOnly", { status: p2.status, body: await text(p2) });
        // And the other documented route: a fresh mailing on the step with a send time.
        const stepRes = await outreachRequest(`/sequenceSteps?filter[sequence][id]=${sequence.id}&sort=order&page[size]=1&fields[sequenceStep]=order,stepType`);
        const step = stepRes.ok ? ((await stepRes.json()) as { data?: Array<{ id: string }> }).data?.[0] : null;
        note("firstStep", step ?? await text(stepRes));
        if (step) {
          const create = await outreachRequest(`/mailings`, {
            method: "POST",
            body: JSON.stringify({
              data: {
                type: "mailing",
                attributes: { subject: "API test (ignore)", bodyHtml: "<p>API test body. Ignore.</p>", scheduledAt: sendAt.toISOString(), mailingType: "sequence" },
                relationships: {
                  prospect: { data: { type: "prospect", id: prospect.id } },
                  mailbox: { data: { type: "mailbox", id: mailbox.id } },
                  sequence: { data: { type: "sequence", id: sequence.id } },
                  sequenceState: { data: { type: "sequenceState", id: state.id } },
                  sequenceStep: { data: { type: "sequenceStep", id: step.id } },
                },
              },
            }),
          });
          note("createMailingOnStep", { status: create.status, body: await text(create) });
        }
      }

      const after = await outreachRequest(`/mailings/${mailing.id}?fields[mailing]=state,subject,scheduledAt,mailingType`);
      note("draftMailingAfter", after.ok ? ((await after.json()) as { data?: unknown }).data : await text(after));
    }

    if (!keep) {
      const del = await outreachRequest(`/sequenceStates/${state.id}`, { method: "DELETE" });
      note("cleanupRemovedFromSequence", { status: del.status, body: del.status === 204 ? "" : await text(del) });
      if (mailing) {
        const m = await outreachRequest(`/mailings/${mailing.id}?fields[mailing]=state,scheduledAt`);
        note("mailingAfterCleanup", m.ok ? ((await m.json()) as { data?: unknown }).data : `${m.status}: ${await text(m)}`);
      }
    }
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ ...report, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
