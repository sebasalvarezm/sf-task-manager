import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { fetchOpenTasks } from "@/lib/salesforce";

// Returns all open tasks from Salesforce for the connected user.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const tasks = await fetchOpenTasks();
    return NextResponse.json({ tasks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (message === "NOT_CONNECTED") {
      return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 403 });
    }

    console.error("fetchOpenTasks error:", message);
    return NextResponse.json(
      { error: "Failed to fetch tasks from Salesforce" },
      { status: 500 }
    );
  }
}
