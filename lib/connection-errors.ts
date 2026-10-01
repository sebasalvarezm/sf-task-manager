// Plain-English text for the internal "not connected" error codes, for API
// routes whose pages show `error` as-is. Routes whose pages check for the
// exact code (e.g. tasks, stats) keep returning the code.
const FRIENDLY: Record<string, string> = {
  NOT_CONNECTED: "Salesforce isn't connected. Connect Salesforce from the Home page and try again.",
  MS_NOT_CONNECTED: "Outlook isn't connected. Connect Outlook and try again.",
  OUTREACH_NOT_CONNECTED: "Outreach isn't connected. Connect Outreach and try again.",
};

/** The friendly sentence for a connection code, or the message unchanged. */
export function friendlyConnectionError(message: string): string {
  return FRIENDLY[message] ?? message;
}

/** True for NOT_CONNECTED / MS_NOT_CONNECTED / OUTREACH_NOT_CONNECTED. */
export function isConnectionError(message: string): boolean {
  return message in FRIENDLY;
}
