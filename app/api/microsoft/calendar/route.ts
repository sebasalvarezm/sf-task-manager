import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { fetchCalendarEvents } from "@/lib/microsoft";
import { findAccountByDomain, findExistingCallTasks } from "@/lib/salesforce-calls";

// Domains to exclude (internal organizations)
const EXCLUDED_DOMAINS = [
  "valstonecorp.com",
  "valsoftcorp.com",
  "awsys.com",
  "valstonecorporation.onmicrosoft.com",
  "creativeinfo.net",
];

// Extract email addresses from HTML or plain-text body content
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function extractEmailsFromBody(bodyText: string): string[] {
  if (!bodyText) return [];
  const matches = bodyText.match(EMAIL_REGEX);
  if (!matches) return [];
  // Deduplicate and lowercase
  return [...new Set(matches.map((e) => e.toLowerCase()))];
}

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

    // Step 2: Process each event — filter attendees, match to Salesforce
    const meetings: MeetingMatch[] = [];

    for (const event of events) {
      // Collect all attendees (including organizer)
      const allEmails: string[] = [];
      if (event.organizer?.email) allEmails.push(event.organizer.email);
      for (const a of event.attendees) {
        if (a.email) allEmails.push(a.email);
      }

      // Extract unique domains, excluding internal ones
      const domainSet = new Set<string>();
      for (const email of allEmails) {
        const domain = email.split("@")[1];
        if (domain && !EXCLUDED_DOMAINS.includes(domain.toLowerCase())) {
          domainSet.add(domain.toLowerCase());
        }
      }

      // Extract just the date portion from the start datetime
      const meetingDate = event.start.split("T")[0];
      const startTime = event.start.split("T")[1]?.substring(0, 5) ?? "";

      // If no external attendees found, try extracting emails from the body
      // (migration sometimes strips attendees but keeps them in body text)
      if (domainSet.size === 0 && event.bodyText) {
        const bodyEmails = extractEmailsFromBody(event.bodyText);
        for (const email of bodyEmails) {
          const domain = email.split("@")[1];
          if (domain && !EXCLUDED_DOMAINS.includes(domain.toLowerCase())) {
            domainSet.add(domain.toLowerCase());
          }
        }
      }

      // Skip meetings with no external attendees (truly internal)
      if (domainSet.size === 0) continue;

      const externalDomains = Array.from(domainSet);

      // Step 3: Match each external domain to a Salesforce Account
      const allMatches: MeetingMatch["allMatches"] = [];
      for (const domain of externalDomains) {
        try {
          const match = await findAccountByDomain(domain);
          if (match) {
            allMatches.push({
              accountId: match.accountId,
              accountName: match.accountName,
              accountUrl: match.accountUrl,
              domain,
            });
          }
        } catch {
          // If one domain lookup fails, continue with the others
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

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
