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

type Props = {
  selected: WeekRange | null;
  onChange: (week: WeekRange) => void;
};

export default function WeekSelector({ selected, onChange }: Props) {
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
        {weeks.map((w) => (
          <option key={w.start} value={`${w.start}|${w.end}`}>
            {w.label}
          </option>
        ))}
      </select>
    </div>
  );
}
