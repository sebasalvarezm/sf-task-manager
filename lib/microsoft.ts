import { getSupabaseAdmin } from "./supabase";

// How long (in minutes) before we proactively refresh the access token.
// Microsoft tokens last 60-90 minutes; we refresh after 45 minutes.
const REFRESH_THRESHOLD_MINUTES = 45;

export type MsCredentials = {
  id: string;
  access_token: string;
  refresh_token: string;
  token_issued_at: string;
  updated_at: string;
};

// ── Token management ──────────────────────────────────────────────────────────

export async function getMsValidCredentials(): Promise<MsCredentials | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("ms_credentials")
    .select("*")
    .eq("id", "default")
    .single();

  if (error || !data) return null;

  const credentials = data as MsCredentials;

  // Check if the token is old enough to need refreshing
  const issuedAt = new Date(credentials.token_issued_at);
  const ageMinutes = (Date.now() - issuedAt.getTime()) / 1000 / 60;

  if (ageMinutes > REFRESH_THRESHOLD_MINUTES) {
    return await refreshMsAccessToken(credentials);
  }

  return credentials;
}

async function refreshMsAccessToken(
  credentials: MsCredentials
): Promise<MsCredentials | null> {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing MS_CLIENT_ID or MS_CLIENT_SECRET in environment.");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: credentials.refresh_token,
    scope: "Calendars.Read Mail.Read Mail.Send User.Read offline_access",
  });

  const tenantId = process.env.MS_TENANT_ID ?? "common";
  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  );

  if (!response.ok) {
    // Refresh token has expired or been revoked — user needs to reconnect
    const supabase = getSupabaseAdmin();
    await supabase.from("ms_credentials").delete().eq("id", "default");
    return null;
  }

  const tokenData = await response.json();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("ms_credentials")
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? credentials.refresh_token,
      token_issued_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", "default")
    .select()
    .single();

  if (error || !data) return null;
  return data as MsCredentials;
}

// ── Fetch Emails API ─────────────────────────────────────────────────────────

export type OutlookEmail = {
  id: string;
  subject: string;
  from: { name: string; email: string };
  receivedDateTime: string;
  bodyPreview: string;
  bodyText: string;
  conversationId: string;
  isRead: boolean;
};

export async function fetchRecentEmails(
  sinceHours: number = 24
): Promise<OutlookEmail[]> {
  const credentials = await getMsValidCredentials();
  if (!credentials) throw new Error("MS_NOT_CONNECTED");

  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${since}`,
    $select: "id,subject,from,receivedDateTime,bodyPreview,body,conversationId,isRead",
    $orderby: "receivedDateTime desc",
    $top: "50",
  });

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
        Prefer: 'outlook.body-content-type="text"',
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to fetch emails: ${err}`);
  }

  const data = await response.json();

  return (data.value ?? []).map(
    (e: {
      id: string;
      subject: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      receivedDateTime: string;
      bodyPreview: string;
      body?: { content?: string };
      conversationId: string;
      isRead: boolean;
    }): OutlookEmail => ({
      id: e.id,
      subject: e.subject ?? "(No subject)",
      from: {
        name: e.from?.emailAddress?.name ?? "",
        email: (e.from?.emailAddress?.address ?? "").toLowerCase(),
      },
      receivedDateTime: e.receivedDateTime,
      bodyPreview: e.bodyPreview ?? "",
      bodyText: e.body?.content ?? "",
      conversationId: e.conversationId,
      isRead: e.isRead,
    })
  );
}

export async function fetchEmailThread(
  conversationId: string
): Promise<OutlookEmail[]> {
  const credentials = await getMsValidCredentials();
  if (!credentials) throw new Error("MS_NOT_CONNECTED");

  const params = new URLSearchParams({
    $filter: `conversationId eq '${conversationId}'`,
    $select: "id,subject,from,receivedDateTime,bodyPreview,body,conversationId,isRead",
    $orderby: "receivedDateTime asc",
    $top: "10",
  });

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
        Prefer: 'outlook.body-content-type="text"',
      },
    }
  );

  if (!response.ok) return [];

  const data = await response.json();

  return (data.value ?? []).map(
    (e: {
      id: string;
      subject: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      receivedDateTime: string;
      bodyPreview: string;
      body?: { content?: string };
      conversationId: string;
      isRead: boolean;
    }): OutlookEmail => ({
      id: e.id,
      subject: e.subject ?? "(No subject)",
      from: {
        name: e.from?.emailAddress?.name ?? "",
        email: (e.from?.emailAddress?.address ?? "").toLowerCase(),
      },
      receivedDateTime: e.receivedDateTime,
      bodyPreview: e.bodyPreview ?? "",
      bodyText: e.body?.content ?? "",
      conversationId: e.conversationId,
      isRead: e.isRead,
    })
  );
}

// ── Send Email API ───────────────────────────────────────────────────────────

export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  const credentials = await getMsValidCredentials();
  if (!credentials) throw new Error("MS_NOT_CONNECTED");

  const response = await fetch(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: params.subject,
          body: {
            contentType: "Text",
            content: params.body,
          },
          toRecipients: [
            {
              emailAddress: {
                address: params.to,
              },
            },
          ],
        },
        saveToSentItems: true,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to send email: ${err}`);
  }
}

// ── Calendar API ──────────────────────────────────────────────────────────────

export type CalendarEvent = {
  id: string;
  subject: string;
  start: string; // ISO datetime
  end: string;
  organizer: { name: string; email: string } | null;
  attendees: Array<{ name: string; email: string }>;
  bodyText: string; // plain-text body (used to recover attendee emails)
};

export async function fetchCalendarEvents(
  startDate: string,
  endDate: string
): Promise<CalendarEvent[]> {
  const credentials = await getMsValidCredentials();
  if (!credentials) throw new Error("MS_NOT_CONNECTED");

  // Microsoft Graph calendarView expects ISO datetimes
  const startDateTime = `${startDate}T00:00:00`;
  const endDateTime = `${endDate}T23:59:59`;

  const params = new URLSearchParams({
    startDateTime,
    endDateTime,
    $select: "id,subject,start,end,organizer,attendees,body",
    $orderby: "start/dateTime",
    $top: "100",
  });

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarView?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Microsoft Graph API failed: ${err}`);
  }

  const data = await response.json();

  return (data.value ?? []).map(
    (e: {
      id: string;
      subject: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
      organizer?: { emailAddress?: { name?: string; address?: string } };
      attendees?: Array<{
        emailAddress?: { name?: string; address?: string };
      }>;
      body?: { contentType?: string; content?: string };
    }): CalendarEvent => ({
      id: e.id,
      subject: e.subject ?? "(No subject)",
      start: e.start.dateTime,
      end: e.end.dateTime,
      organizer: e.organizer?.emailAddress
        ? {
            name: e.organizer.emailAddress.name ?? "",
            email: (e.organizer.emailAddress.address ?? "").toLowerCase(),
          }
        : null,
      attendees: (e.attendees ?? []).map((a) => ({
        name: a.emailAddress?.name ?? "",
        email: (a.emailAddress?.address ?? "").toLowerCase(),
      })),
      bodyText: e.body?.content ?? "",
    })
  );
}
