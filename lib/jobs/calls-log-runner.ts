import {
  findExistingCallTasks,
  createCompletedCallTask,
  upsertFollowUpTask,
  createAccountNote,
} from "@/lib/salesforce-calls";
import { assertSalesforceId } from "@/lib/sf-query";

export type CallLogEntry = {
  eventId: string;
  accountId: string;
  accountName: string;
  callType: "C1" | "RCC";
  commentary: string;
  meetingDate: string;
  followUpDays: number | null;
  notes: string;
};

export type CallLogResult = {
  eventId: string;
  accountName: string;
  callType: string;
  success: boolean;
  error?: string;
  followUpCreated: boolean;
  /** created = new task; moved = existing open task pushed to the new date. */
  followUpAction?: "created" | "moved" | null;
  followUpDate?: string | null;
  noteCreated: boolean;
  /** True when Salesforce already had this call, so nothing was written. */
  alreadyLogged?: boolean;
};

export type CallsLogRunResult = {
  results: CallLogResult[];
  successCount: number;
  failCount: number;
};

export async function runOneCallLog(entry: CallLogEntry): Promise<CallLogResult> {
  try {
    // Duplicate guard. A double submit, a cancelled-then-resubmitted batch or
    // a retry after a timeout must not create a second C1/RCC task, follow-up
    // or note. If Salesforce already has a completed task of the same call
    // type on this account for the meeting date, skip the whole entry.
    assertSalesforceId(entry.accountId, "account id");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.meetingDate)) {
      throw new Error("Invalid meeting date");
    }
    if (entry.callType !== "C1" && entry.callType !== "RCC") {
      throw new Error("Call type must be C1 or RCC");
    }
    const existing = await findExistingCallTasks(
      [entry.accountId],
      entry.meetingDate,
      entry.meetingDate,
      entry.callType,
    );
    if (existing.has(entry.accountId)) {
      return {
        eventId: entry.eventId,
        accountName: entry.accountName,
        callType: entry.callType,
        success: true,
        alreadyLogged: true,
        followUpCreated: false,
        noteCreated: false,
      };
    }

    const subject = entry.commentary ? `${entry.callType} - ${entry.commentary}` : entry.callType;
    await createCompletedCallTask({
      accountId: entry.accountId,
      subject,
      subjectType: entry.callType,
      meetingDate: entry.meetingDate,
    });
    let followUpCreated = false;
    let followUpAction: "created" | "moved" | null = null;
    let followUpDate: string | null = null;
    if (entry.followUpDays && entry.followUpDays > 0) {
      const outcome = await upsertFollowUpTask({
        accountId: entry.accountId,
        subject: "RCE",
        subjectType: "RCE1",
        meetingDate: entry.meetingDate,
        daysFromMeeting: entry.followUpDays,
      });
      followUpCreated = true;
      followUpAction = outcome.action;
      followUpDate = outcome.date;
    }
    let noteCreated = false;
    if (entry.notes && entry.notes.trim()) {
      await createAccountNote({
        accountId: entry.accountId,
        title: `${entry.callType} Notes`,
        content: entry.notes.trim(),
      });
      noteCreated = true;
    }
    return { eventId: entry.eventId, accountName: entry.accountName, callType: entry.callType, success: true, followUpCreated, followUpAction, followUpDate, noteCreated };
  } catch (err) {
    return {
      eventId: entry.eventId,
      accountName: entry.accountName,
      callType: entry.callType,
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
      followUpCreated: false,
      noteCreated: false,
    };
  }
}

