"use client";

import { startOfWeek, addWeeks, format, endOfWeek, differenceInWeeks } from "date-fns";

export type WeekRange = {
  label: string;
  start: string; // "yyyy-MM-dd"
  end: string;   // "yyyy-MM-dd"
};

// Generates weeks from Jan 1 of the current year through 7 weeks ahead
export function generateWeeks(): WeekRange[] {
  const today = new Date();
  const jan1 = new Date(today.getFullYear(), 0, 1);
  const firstMonday = startOfWeek(jan1, { weekStartsOn: 1 });
  const currentMonday = startOfWeek(today, { weekStartsOn: 1 });
  const weeksBack = differenceInWeeks(currentMonday, firstMonday);

  const weeks: WeekRange[] = [];

  for (let i = -weeksBack; i <= 7; i++) {
    const weekStart = startOfWeek(addWeeks(today, i), { weekStartsOn: 1 }); // Monday
    const weekEnd = endOfWeek(addWeeks(today, i), { weekStartsOn: 1 });

    const start = format(weekStart, "yyyy-MM-dd");
    const end = format(weekEnd, "yyyy-MM-dd");

    const isThisWeek = i === 0;
    const label = `${format(weekStart, "MMM d")} – ${format(weekEnd, "MMM d, yyyy")}${isThisWeek ? " (This week)" : ""}`;

    weeks.push({ label, start, end });
  }

  return weeks;
}

// Index of the current week in the generated array
export function currentWeekIndex(): number {
  const today = new Date();
  const jan1 = new Date(today.getFullYear(), 0, 1);
  const firstMonday = startOfWeek(jan1, { weekStartsOn: 1 });
  const currentMonday = startOfWeek(today, { weekStartsOn: 1 });
  return differenceInWeeks(currentMonday, firstMonday);
}

// ── Completed weeks (localStorage) ────────────────────────────────────────────

const COMPLETED_KEY = "call_logger_completed_weeks";

export function getCompletedWeeks(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(COMPLETED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function markWeekCompleted(start: string, end: string) {
  const completed = getCompletedWeeks();
  completed.add(`${start}|${end}`);
  localStorage.setItem(COMPLETED_KEY, JSON.stringify([...completed]));
}

// ── Component ─────────────────────────────────────────────────────────────────

type Props = {
  selected: WeekRange | null;
  onChange: (week: WeekRange) => void;
  completedWeeks?: Set<string>; // set of "start|end" keys
};

export default function WeekSelector({ selected, onChange, completedWeeks }: Props) {
  const weeks = generateWeeks();

  const cwIdx = currentWeekIndex();
  const currentValue = selected ? `${selected.start}|${selected.end}` : `${weeks[cwIdx].start}|${weeks[cwIdx].end}`;

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const [start, end] = e.target.value.split("|");
    const week = weeks.find((w) => w.start === start && w.end === end);
    if (week) onChange(week);
  }

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium text-navy whitespace-nowrap">
        Select week:
      </label>
      <select
        value={currentValue}
        onChange={handleChange}
        className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange min-w-[260px]"
      >
        {weeks.map((w) => {
          const key = `${w.start}|${w.end}`;
          const isDone = completedWeeks?.has(key);
          return (
            <option key={w.start} value={key}>
              {w.label}{isDone ? " (Completed)" : ""}
            </option>
          );
        })}
      </select>
    </div>
  );
}
