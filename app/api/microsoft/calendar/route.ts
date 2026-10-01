import { NextRequest, NextResponse } from "next/server";
import { friendlyConnectionError } from "@/lib/connection-errors";
import { isAuthenticated } from "@/lib/auth";
import { fetchCalendarEvents } from "@/lib/microsoft";
import { findAccountsByDomains, findExistingCallTasks } from "@/lib/salesforce-calls";
import { externalMeetingsFromEvents, weekDomains } from "@/lib/call-logger-meetings";

export type MeetingMatch = {
  eventId: string;
  subject: string;
  meetingDate: string; // ISO date: "2026-03-05"
  startTime: string; // e.g. "10:00"
  externalDomains: string[];
  match: {
    accountId: string;
    accountName: string;
    accountUrl: string;
  } | null;
  allMatches: Array<{
    accountId: string;
    accountName: string;
    accountUrl: string;
    domain: string;
  }>;
  alreadyLogged: boolean;
};

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Missing start or end date" },
      { status: 400 }
    );
  }

  try {
    // Step 1: Fetch all calendar events for the week
    const events = await fetchCalendarEvents(start, end);

    // Collect every external domain first, then resolve them in one Salesforce
    // query. This replaces the former one-query-per-domain slow path.
    const accountByDomain = await findAccountsByDomains(weekDomains(events));

    // Step 2: Keep meetings with an external attendee and match each external
    // domain to a Salesforce Account. (Same rule the Granola sync uses.)
    const meetings: MeetingMatch[] = [];

    for (const external of externalMeetingsFromEvents(events)) {
      const { event, externalDomains, meetingDate, startTime } = external;

      const allMatches: MeetingMatch["allMatches"] = [];
      for (const domain of externalDomains) {
        const match = accountByDomain.get(domain);
        if (match) {
          allMatches.push({
            accountId: match.accountId,
            accountName: match.accountName,
            accountUrl: match.accountUrl,
            domain,
          });
        }
      }

      meetings.push({
        eventId: event.id,
        subject: event.subject,
        meetingDate,
        startTime,
        externalDomains,
        match: allMatches.length > 0
          ? {
              accountId: allMatches[0].accountId,
              accountName: allMatches[0].accountName,
              accountUrl: allMatches[0].accountUrl,
            }
          : null,
        allMatches,
        alreadyLogged: false, // will be updated below
      });
    }

    // Step 4: Check which matched accounts already have C1/RCC tasks this week
    const matchedAccountIds = [
      ...new Set(
        meetings.flatMap((m) => m.allMatches.map((a) => a.accountId))
      ),
    ];
    if (matchedAccountIds.length > 0) {
      try {
        const loggedAccountIds = await findExistingCallTasks(
          matchedAccountIds,
          start,
          end
        );
        for (const meeting of meetings) {
          const primaryAccountId = meeting.match?.accountId;
          if (primaryAccountId && loggedAccountIds.has(primaryAccountId)) {
            meeting.alreadyLogged = true;
          }
        }
      } catch {
        // Non-critical — if check fails, rows just won't be flagged
      }
    }

    return NextResponse.json({ meetings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";

    if (message === "MS_NOT_CONNECTED") {
      return NextResponse.json(
        { error: "MS_NOT_CONNECTED" },
        { status: 401 }
      );
    }
    if (message === "NOT_CONNECTED") {
      return NextResponse.json(
        { error: friendlyConnectionError(message), code: message },
        { status: 409 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
