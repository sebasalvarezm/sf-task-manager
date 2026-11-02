/**
 * One-off clean-up for nudges and follow-ups sent before the Nov 2026 fix.
 * Those sends completed the open RCE task (so it counted as an RCE) and
 * opened a new one. The fix: the false completed RCE is deleted (Salesforce
 * keeps it in the Recycle Bin for 15 days), and an account left with no open
 * task gets its task back.
 */
export type CompletedRow = {
  Id: string;
  Subject: string | null;
  Type: string | null;
  Description: string | null;
  AccountId: string | null;
  LastModifiedDate: string;
  ActivityDate: string | null;
  Account?: { Name?: string } | null;
};
export type LaterRow = { Id: string; AccountId: string | null; CreatedDate: string };

export type CleanupItem = {
  id: string;
  account: string;
  sentOn: string;
  /** true when the nudge opened a new task, so this one only needs re-tagging */
  hasNextTask: boolean;
};

/** A nudge-completed task: RCE subject, not a logged email, description is the email that went out. */
export function isNudgeRecord(r: CompletedRow): boolean {
  return (
    r.Type !== "Email" &&
    /^RCE\b/.test((r.Subject ?? "").trim()) &&
    /^(hi|hello|dear)\b/i.test((r.Description ?? "").trim())
  );
}

export function cleanupItems(completed: CompletedRow[], later: LaterRow[]): CleanupItem[] {
  return completed.filter(isNudgeRecord).map((r) => {
    const at = Date.parse(r.LastModifiedDate);
    const hasNextTask = later.some(
      (t) => t.AccountId === r.AccountId && t.Id !== r.Id && Math.abs(Date.parse(t.CreatedDate) - at) < 120_000,
    );
    return { id: r.Id, account: r.Account?.Name ?? "Account", sentOn: r.LastModifiedDate.slice(0, 10), hasNextTask };
  });
}

/** The Salesforce change for one item. */
export function cleanupChange(item: CleanupItem): { method: "DELETE" } | { method: "PATCH"; body: Record<string, unknown> } {
  // A new open task was opened after it, so this completed one is only a false RCE.
  if (item.hasNextTask) return { method: "DELETE" };
  // No task was opened after it, so this was the account's only open task: put it back.
  return { method: "PATCH", body: { Status: "Open", Description: null } };
}
