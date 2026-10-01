// Turn an error response from Microsoft Graph or Outreach into one readable
// sentence, instead of putting the raw JSON body on screen.
//
// Graph:    {"error":{"code":"ErrorItemNotFound","message":"The specified object was not found in the store."}}
// Outreach: {"errors":[{"id":"validationError","title":"Validation Error","detail":"Emails has already been taken"}]}

function stripHtml(raw: string): string {
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function upstreamErrorText(service: string, response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: unknown; message?: unknown } | string;
      error_description?: unknown;
      errors?: Array<{ title?: unknown; detail?: unknown; id?: unknown }>;
      message?: unknown;
    };
    if (parsed.error && typeof parsed.error === "object") {
      const msg = typeof parsed.error.message === "string" ? parsed.error.message : null;
      const code = typeof parsed.error.code === "string" ? parsed.error.code : null;
      if (msg) return `${service} said: ${msg}${code ? ` (${code})` : ""}`;
    }
    if (typeof parsed.error_description === "string") {
      return `${service} said: ${parsed.error_description}`;
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const parts = parsed.errors
        .map((e) => (typeof e.detail === "string" ? e.detail : typeof e.title === "string" ? e.title : null))
        .filter((p): p is string => Boolean(p));
      if (parts.length > 0) return `${service} said: ${parts.join("; ")}`;
    }
    if (typeof parsed.message === "string") return `${service} said: ${parsed.message}`;
  } catch {
    // not JSON
  }
  const text = stripHtml(raw);
  return text
    ? `${service} returned HTTP ${response.status}: ${text}`
    : `${service} returned HTTP ${response.status}`;
}
