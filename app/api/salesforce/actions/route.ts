import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  hardDeleteTask,
  completeAndReschedule,
  delayTask,
  logAction,
} from "@/lib/salesforce";

type ActionItem = {
  taskId: string;
  accountId: string | null;
  accountName: string | null;
  subject: string;
  currentDate: string;
  actionType: "hard_delete" | "complete_reschedule" | "delay";
  days?: number;
};

type ActionResult = {
  taskId: string;
  accountName: string | null;
  actionType: string;
  success: boolean;
  error?: string;
};

// Executes a batch of task actions (delete, reschedule, delay).
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { actions }: { actions: ActionItem[] } = await request.json();

  if (!Array.isArray(actions) || actions.length === 0) {
    return NextResponse.json(
      { error: "No actions provided" },
      { status: 400 }
    );
  }

  const results: ActionResult[] = [];

  for (const action of actions) {
    let success = true;
    let errorMessage: string | undefined;
    let newDate: string | undefined;

    try {
      if (action.actionType === "hard_delete") {
        await hardDeleteTask(action.taskId);

      } else if (action.actionType === "complete_reschedule") {
        if (!action.days || action.days < 1) {
          throw new Error("Days must be at least 1 for reschedule");
        }
        if (!action.accountId) {
          throw new Error("AccountId required for reschedule");
        }
        await completeAndReschedule(
          action.taskId,
          action.accountId,
          action.subject,
          action.days
        );

      } else if (action.actionType === "delay") {
        if (!action.days || action.days < 1) {
          throw new Error("Days must be at least 1 for delay");
        }
        newDate = await delayTask(action.taskId, action.currentDate, action.days);
      }
    } catch (error) {
      success = false;
      errorMessage = error instanceof Error ? error.message : "Unknown error";
    }

    // Log every action to Supabase regardless of success/failure
    await logAction({
      taskId: action.taskId,
      accountName: action.accountName,
      actionType: action.actionType,
      daysUsed: action.days,
      oldDate: action.currentDate,
      newDate,
      success,
      errorMessage,
    });

    results.push({
      taskId: action.taskId,
      accountName: action.accountName,
      actionType: action.actionType,
      success,
      error: errorMessage,
    });
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  return NextResponse.json({ results, successCount, failCount });
}
