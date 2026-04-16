import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  findProspectByEmail,
  createProspect,
  addProspectToSequence,
  tryPatchMailingSubject,
} from "@/lib/outreach";

// POST /api/outreach/push
// Creates a PAUSED sequence enrollment in Outreach (draft mode).
// Does NOT touch Salesforce — Outreach's SF sync will auto-create
// the SF task when the email is actually sent from Outreach.
//
// Body: { accountName, contact: {firstName,lastName,email,title},
//         sequenceId, mailboxId, firstE1Subject? }
// Returns: { outreach_prospect, sequence_state, mailing_patch }
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    accountName?: string;
    contact?: {
      firstName?: string;
      lastName?: string;
      email?: string;
      title?: string;
    };
    sequenceId?: string;
    mailboxId?: string;
    firstE1Subject?: string | null;
  };

  if (
    !body.contact?.email ||
    !body.contact.lastName ||
    !body.sequenceId ||
    !body.mailboxId
  ) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: contact.email, contact.lastName, sequenceId, mailboxId",
      },
      { status: 400 }
    );
  }

  const result: {
    outreach_prospect: {
      ok: boolean;
      prospectId?: string;
      created?: boolean;
      error?: string;
    };
    sequence_state: { ok: boolean; id?: string; error?: string };
    mailing_patch: { ok: boolean; patched?: boolean; error?: string };
  } = {
    outreach_prospect: { ok: false },
    sequence_state: { ok: false },
    mailing_patch: { ok: false },
  };

  // Step 1: Find-or-create Outreach prospect
  let prospectId: string | null = null;
  try {
    const existing = await findProspectByEmail(body.contact.email);
    if (existing) {
      prospectId = existing.id;
      result.outreach_prospect = {
        ok: true,
        prospectId: existing.id,
        created: false,
      };
    } else {
      const created = await createProspect({
        firstName: body.contact.firstName ?? "",
        lastName: body.contact.lastName,
        email: body.contact.email,
        title: body.contact.title,
        company: body.accountName,
      });
      prospectId = created.id;
      result.outreach_prospect = {
        ok: true,
        prospectId: created.id,
        created: true,
      };
    }
  } catch (e: unknown) {
    result.outreach_prospect = {
      ok: false,
      error: e instanceof Error ? e.message : "Outreach prospect error",
    };
  }

  // Step 2: Add prospect to sequence (as PAUSED — draft mode)
  let sequenceStateId: string | null = null;
  if (prospectId) {
    try {
      const state = await addProspectToSequence({
        prospectId,
        sequenceId: body.sequenceId,
        mailboxId: body.mailboxId,
      });
      sequenceStateId = state.id;
      result.sequence_state = { ok: true, id: state.id };
    } catch (e: unknown) {
      result.sequence_state = {
        ok: false,
        error: e instanceof Error ? e.message : "Sequence enroll error",
      };
    }
  } else {
    result.sequence_state = {
      ok: false,
      error: "Prospect step failed; cannot enroll",
    };
  }

  // Step 3: Try to patch the first mailing's subject with the first-hit E1 subject
  if (sequenceStateId && body.firstE1Subject) {
    try {
      const patch = await tryPatchMailingSubject(
        sequenceStateId,
        body.firstE1Subject
      );
      result.mailing_patch = {
        ok: patch.patched,
        patched: patch.patched,
        error: patch.reason,
      };
    } catch (e: unknown) {
      result.mailing_patch = {
        ok: false,
        error: e instanceof Error ? e.message : "Mailing patch error",
      };
    }
  } else if (!body.firstE1Subject) {
    result.mailing_patch = { ok: true, error: "No E1 subject to patch" };
  }

  return NextResponse.json(result);
}
