import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  createCompletedCallTask,
  createFollowUpTask,
} from "@/lib/salesforce-calls";

export type CallLogEntry = {
  accountId: string;
  accountName: string;
  callType: "C1" | "RCC";
  commentary: string;
  meetingDate: string; // ISO date
  followUpDays: number | null; // e.g. 14 for RCE14, null for no follow-up
};

export type CallLogResult = {
  accountName: string;
  callType: string;
  success: boolean;
  error?: string;
  followUpCreated: boolean;
};

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let entries: CallLogEntry[];
  try {
    const body = await request.json();
    entries = body.entries;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!entries || entries.length === 0) {
    return NextResponse.json(
      { error: "No entries to process" },
      { status: 400 }
    );
  }

  const results: CallLogResult[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const entry of entries) {
    try {
      // Build the subject line: "C1 - 10M, young, reconnect in future"
      const subject = entry.commentary
        ? `${entry.callType} - ${entry.commentary}`
        : entry.callType;

      // Step 1: Create the completed call task
      await createCompletedCallTask({
        accountId: entry.accountId,
        subject,
        subjectType: entry.callType,
        meetingDate: entry.meetingDate,
      });

      // Step 2: Create follow-up task if requested
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

      results.push({
        accountName: entry.accountName,
        callType: entry.callType,
        success: true,
        followUpCreated,
      });
      successCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        accountName: entry.accountName,
        callType: entry.callType,
        success: false,
        error: message,
        followUpCreated: false,
      });
      failCount++;
    }
  }

  return NextResponse.json({ results, successCount, failCount });
}
