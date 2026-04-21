import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getValidCredentials } from "@/lib/token-manager";

// GET /api/dashboard/summary
// Returns quick counts for the morning dashboard strip.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary: {
    overdueTasks: number | null;
    dueOutreach: number | null;
  } = {
    overdueTasks: null,
    dueOutreach: null,
  };

  // 1. Count overdue tasks (due date < today, still open)
  try {
    const creds = await getValidCredentials();
    if (creds) {
      const today = new Date().toISOString().split("T")[0];
      const query = encodeURIComponent(
        `SELECT COUNT() FROM Task ` +
          `WHERE Status = 'Open' ` +
          `AND OwnerId = '${creds.salesforce_user_id}' ` +
          `AND ActivityDate < ${today}`
      );
      const res = await fetch(
        `${creds.instance_url}/services/data/v62.0/query/?q=${query}`,
        {
          headers: {
            Authorization: `Bearer ${creds.access_token}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (res.ok) {
        const data = await res.json();
        summary.overdueTasks = data.totalSize ?? 0;
      }
    }
  } catch {
    // Non-fatal
  }

  // 2. Count accounts due for outreach (reuse the queue logic but just count)
  // To avoid the heavy buildQueue call, do a lightweight SOQL count
  try {
    const creds = await getValidCredentials();
    if (creds) {
      const query = encodeURIComponent(
        `SELECT COUNT(AccountId) cnt FROM Task ` +
          `WHERE Subject_Type__c = 'E5' ` +
          `AND Status = 'Completed' ` +
          `AND CompletedDateTime >= 2026-01-01T00:00:00Z ` +
          `AND AccountId != null ` +
          `GROUP BY AccountId`
      );
      const res = await fetch(
        `${creds.instance_url}/services/data/v62.0/query/?q=${query}`,
        {
          headers: {
            Authorization: `Bearer ${creds.access_token}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (res.ok) {
        const data = await res.json();
        // totalSize = number of distinct accounts with a 2026 E5
        summary.dueOutreach = data.totalSize ?? 0;
      }
    }
  } catch {
    // Non-fatal
  }

  return NextResponse.json(summary);
}
