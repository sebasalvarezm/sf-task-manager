import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { upsertContact } from "@/lib/salesforce-contacts";
import {
  findProspectByEmail,
  createProspect,
  addProspectToSequence,
} from "@/lib/outreach";

// POST /api/outreach/push
// Body: { accountId, accountName, contact: {firstName,lastName,email,title},
//         sequenceId, mailboxId }
// Returns: { sf: {...}, outreach_prospect: {...}, sequence_state: {...} }
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    accountId?: string;
    accountName?: string;
    contact?: {
      firstName?: string;
      lastName?: string;
      email?: string;
      title?: string;
    };
    sequenceId?: string;
    mailboxId?: string;
  };

  if (
    !body.accountId ||
    !body.contact?.email ||
    !body.contact.lastName ||
    !body.sequenceId ||
    !body.mailboxId
  ) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: accountId, contact.email, contact.lastName, sequenceId, mailboxId",
      },
      { status: 400 }
    );
  }

  const result: {
    sf: { ok: boolean; contactId?: string; created?: boolean; error?: string };
    outreach_prospect: {
      ok: boolean;
      prospectId?: string;
      created?: boolean;
      error?: string;
    };
    sequence_state: { ok: boolean; id?: string; error?: string };
  } = {
    sf: { ok: false },
    outreach_prospect: { ok: false },
    sequence_state: { ok: false },
  };

  // Step 1: Upsert Contact in Salesforce
  try {
    const sfRes = await upsertContact({
      accountId: body.accountId,
      firstName: body.contact.firstName ?? "",
      lastName: body.contact.lastName,
      email: body.contact.email,
      title: body.contact.title,
    });
    result.sf = {
      ok: true,
      contactId: sfRes.id,
      created: sfRes.created,
    };
  } catch (e: unknown) {
    result.sf = {
      ok: false,
      error: e instanceof Error ? e.message : "SF error",
    };
  }

  // Step 2: Find-or-create Outreach prospect
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

  // Step 3: Add prospect to sequence
  if (prospectId) {
    try {
      const state = await addProspectToSequence({
        prospectId,
        sequenceId: body.sequenceId,
        mailboxId: body.mailboxId,
      });
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

  return NextResponse.json(result);
}
