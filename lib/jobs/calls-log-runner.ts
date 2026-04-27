import {
  createCompletedCallTask,
  createFollowUpTask,
  createAccountNote,
} from "@/lib/salesforce-calls";

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
  noteCreated: boolean;
};

export type CallsLogRunResult = {
  results: CallLogResult[];
  successCount: number;
  failCount: number;
};

export async function runCallsLog(input: {
  entries: CallLogEntry[];
}): Promise<CallsLogRunResult> {
  const results: CallLogResult[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const entry of input.entries) {
    try {
      const subject = entry.commentary
        ? `${entry.callType} - ${entry.commentary}`
        : entry.callType;

      await createCompletedCallTask({
        accountId: entry.accountId,
        subject,
        subjectType: entry.callType,
        meetingDate: entry.meetingDate,
      });

      let followUpCreated = false;
      if (entry.followUpDays && entry.followUpDays > 0) {
        await createFollowUpTask({
          accountId: entry.accountId,
          subject: "RCE",
          subjectType: "RCE1",
          meetingDate: entry.meetingDate,
          daysFromMeeting: entry.followUpDays,
        });
        followUpCreated = true;
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

      results.push({
        eventId: entry.eventId,
        accountName: entry.accountName,
        callType: entry.callType,
        success: true,
        followUpCreated,
        noteCreated,
      });
      successCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        eventId: entry.eventId,
        accountName: entry.accountName,
        callType: entry.callType,
        success: false,
        error: message,
        followUpCreated: false,
        noteCreated: false,
      });
      failCount++;
    }
  }

  return { results, successCount, failCount };
}
