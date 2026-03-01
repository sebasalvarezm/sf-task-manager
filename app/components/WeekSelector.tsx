"use client";

import { startOfWeek, addWeeks, format, endOfWeek } from "date-fns";

export type WeekRange = {
  label: string;
  start: string; // "yyyy-MM-dd"
  end: string;   // "yyyy-MM-dd"
};

// Generates 12 weeks: 4 in the past, current week, 7 ahead
export function generateWeeks(): WeekRange[] {
  const today = new Date();
  const weeks: WeekRange[] = [];

  for (let i = -4; i <= 7; i++) {
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

type Props = {
  selected: WeekRange | null;
  onChange: (week: WeekRange) => void;
};

export default function WeekSelector({ selected, onChange }: Props) {
  const weeks = generateWeeks();

  // Default to current week (index 4 = i=0)
  const currentValue = selected ? `${selected.start}|${selected.end}` : `${weeks[4].start}|${weeks[4].end}`;

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
