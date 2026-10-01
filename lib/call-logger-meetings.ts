// Which calendar events are Call Logger rows: anything with at least one
// external attendee (organiser, attendees, or emails in the invite body when
// a migration stripped the attendee list). Shared by the calendar route and
// the Granola sync so both agree on what counts as "in the Call Logger".

import type { CalendarEvent } from "./microsoft";
import { INTERNAL_DOMAINS, graphTimeToUtcIso, type MatchableMeeting } from "./granola-match";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function extractEmailsFromBody(bodyText: string): string[] {
  if (!bodyText) return [];
  const matches = bodyText.match(EMAIL_REGEX);
  if (!matches) return [];
  return [...new Set(matches.map((e) => e.toLowerCase()))];
}

function externalDomain(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain && !INTERNAL_DOMAINS.includes(domain) ? domain : null;
}

export type ExternalMeeting = {
  event: CalendarEvent;
  externalDomains: string[];
  /** Organiser + attendees (+ body emails), lowercased. */
  emails: string[];
  meetingDate: string; // yyyy-MM-dd, as the Call Logger has always shown it
  startTime: string; // HH:mm
  startUtc: string;
};

export function externalMeetingsFromEvents(events: CalendarEvent[]): ExternalMeeting[] {
  const out: ExternalMeeting[] = [];
  for (const event of events) {
    const listed = [event.organizer?.email, ...event.attendees.map((a) => a.email)]
      .filter(Boolean)
      .map((e) => (e as string).toLowerCase());
    const domainSet = new Set(listed.map(externalDomain).filter((d): d is string => Boolean(d)));
    let emails = listed;
    // Migration sometimes strips attendees but keeps them in the body text.
    if (domainSet.size === 0 && event.bodyText) {
      const bodyEmails = extractEmailsFromBody(event.bodyText);
      for (const email of bodyEmails) {
        const d = externalDomain(email);
        if (d) domainSet.add(d);
      }
      emails = [...listed, ...bodyEmails];
    }
    if (domainSet.size === 0) continue; // internal-only meeting: not a Call Logger row
    out.push({
      event,
      externalDomains: Array.from(domainSet),
      emails: Array.from(new Set(emails)),
      meetingDate: event.start.split("T")[0],
      startTime: event.start.split("T")[1]?.substring(0, 5) ?? "",
      startUtc: graphTimeToUtcIso(event.start, event.startTimeZone),
    });
  }
  return out;
}

export function toMatchable(m: ExternalMeeting): MatchableMeeting {
  return {
    eventId: m.event.id,
    iCalUId: m.event.iCalUId,
    subject: m.event.subject,
    startUtc: m.startUtc,
    attendeeEmails: m.emails,
  };
}

/** Every domain worth looking up in Salesforce for this week (incl. body emails). */
export function weekDomains(events: CalendarEvent[]): string[] {
  const set = new Set<string>();
  for (const event of events) {
    const emails = [
      event.organizer?.email,
      ...event.attendees.map((a) => a.email),
      ...extractEmailsFromBody(event.bodyText),
    ].filter(Boolean) as string[];
    for (const email of emails) {
      const d = externalDomain(email);
      if (d) set.add(d);
    }
  }
  return Array.from(set);
}
