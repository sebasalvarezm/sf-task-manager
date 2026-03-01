"use client";

import { SalesforceTask } from "@/lib/salesforce";

export type TaskAction = {
  taskId: string;
  accountId: string | null;
  accountName: string | null;
  subject: string;
  currentDate: string;
  actionType: "none" | "hard_delete" | "complete_reschedule" | "delay";
  days: number;
};

type Props = {
  tasks: SalesforceTask[];
  actions: Map<string, TaskAction>;
  onActionChange: (taskId: string, action: TaskAction) => void;
};

export default function TaskTable({ tasks, actions, onActionChange }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <div className="text-5xl mb-4">✓</div>
        <p className="font-medium">No open tasks for this week</p>
        <p className="text-sm mt-1">Select a different week to see tasks</p>
      </div>
    );
  }

  function getAction(taskId: string): TaskAction {
    return (
      actions.get(taskId) ?? {
        taskId,
        accountId: null,
        accountName: null,
        subject: "",
        currentDate: "",
        actionType: "none",
        days: 30,
      }
    );
  }

  function getSelectClass(actionType: string): string {
    if (actionType === "hard_delete") return "action-select delete";
    if (actionType === "complete_reschedule") return "action-select reschedule";
    if (actionType === "delay") return "action-select delay";
    return "action-select";
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
      <table className="task-table w-full bg-white">
        <thead>
          <tr>
            <th className="w-8">
              <span className="sr-only">Row</span>
            </th>
            <th>Account / Company</th>
            <th>Salesforce Link</th>
            <th>Task Subject</th>
            <th>Due Date</th>
            <th className="min-w-[200px]">Action</th>
            <th className="w-24">Days</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, idx) => {
            const action = getAction(task.Id);
            const needsDays =
              action.actionType === "complete_reschedule" ||
              action.actionType === "delay";

            return (
              <tr key={task.Id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                {/* Row number */}
                <td className="text-center text-xs text-gray-300 font-mono">
                  {idx + 1}
                </td>

                {/* Account Name */}
                <td>
                  <span className="font-medium text-navy">
                    {task.AccountName ?? <span className="text-gray-400 italic">No account</span>}
                  </span>
                </td>

                {/* Salesforce URL */}
                <td>
                  {task.AccountUrl ? (
                    <a
                      href={task.AccountUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-brand-orange hover:text-brand-orange-hover text-sm font-medium underline underline-offset-2"
                    >
                      Open ↗
                    </a>
                  ) : (
                    <span className="text-gray-300 text-sm">—</span>
                  )}
                </td>

                {/* Task Subject */}
                <td>
                  <span className="text-gray-600">{task.Subject}</span>
                </td>

                {/* Due Date */}
                <td>
                  <span className="text-sm text-gray-500 font-mono">
                    {task.ActivityDate ?? "—"}
                  </span>
                </td>

                {/* Action Dropdown */}
                <td>
                  <select
                    value={action.actionType}
                    className={getSelectClass(action.actionType)}
                    onChange={(e) => {
                      const newType = e.target.value as TaskAction["actionType"];
                      onActionChange(task.Id, {
                        taskId: task.Id,
                        accountId: task.AccountId,
                        accountName: task.AccountName,
                        subject: task.Subject,
                        currentDate: task.ActivityDate,
                        actionType: newType,
                        days: action.days || 30,
                      });
                    }}
                  >
                    <option value="none">— No action —</option>
                    <option value="hard_delete">🗑 Hard delete</option>
                    <option value="complete_reschedule">
                      ✅ Mark complete + new task in X days
                    </option>
                    <option value="delay">📅 Delay by X days</option>
                  </select>
                </td>

                {/* Days Input */}
                <td>
                  {needsDays ? (
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={action.days}
                      onChange={(e) => {
                        onActionChange(task.Id, {
                          ...action,
                          days: parseInt(e.target.value) || 30,
                        });
                      }}
                      className="w-16 border border-gray-200 rounded-md px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-brand-orange"
                    />
                  ) : (
                    <span className="text-gray-300 text-sm">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
