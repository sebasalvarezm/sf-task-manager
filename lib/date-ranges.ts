import {
  startOfWeek,
  endOfWeek,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfMonth,
  addWeeks,
  subQuarters,
  eachWeekOfInterval,
  eachMonthOfInterval,
  format,
  isSameDay,
  min as minDate,
} from "date-fns";

export type RangePreset =
  | "this_week"
  | "last_week"
  | "trailing"
  | "this_quarter"
  | "last_quarter"
  | "ytd";

export type Bucket = {
  label: string;        // "Apr 1" or "Jan" etc.
  start: string;        // yyyy-MM-dd
  end: string;          // yyyy-MM-dd
};

export type RangeResult = {
  preset: RangePreset;
  start: string;        // yyyy-MM-dd
  end: string;          // yyyy-MM-dd
  bucket: "week" | "month";
  buckets: Bucket[];
  label: string;        // Human-readable, e.g. "Apr 19 – Apr 25, 2026"
};

const ISO = (d: Date) => format(d, "yyyy-MM-dd");

function weeklyBuckets(start: Date, end: Date): Bucket[] {
  const weeks = eachWeekOfInterval({ start, end }, { weekStartsOn: 0 });
  return weeks.map((ws) => {
    const we = minDate([endOfWeek(ws, { weekStartsOn: 0 }), end]);
    return {
      label: format(ws, "MMM d"),
      start: ISO(ws),
      end: ISO(we),
    };
  });
}

function monthlyBuckets(start: Date, end: Date): Bucket[] {
  const months = eachMonthOfInterval({ start, end });
  return months.map((ms) => {
    const me = minDate([endOfMonth(ms), end]);
    return {
      label: format(ms, "MMM"),
      start: ISO(ms),
      end: ISO(me),
    };
  });
}

export function computeRange(
  preset: RangePreset,
  today: Date = new Date(),
  trailingWeeks: number = 4
): RangeResult {
  const weekOpts = { weekStartsOn: 0 as const };

  switch (preset) {
    case "this_week": {
      const start = startOfWeek(today, weekOpts);
      const end = endOfWeek(today, weekOpts);
      return {
        preset,
        start: ISO(start),
        end: ISO(end),
        bucket: "week",
        buckets: weeklyBuckets(start, end),
        label: `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`,
      };
    }
    case "last_week": {
      const last = addWeeks(today, -1);
      const start = startOfWeek(last, weekOpts);
      const end = endOfWeek(last, weekOpts);
      return {
        preset,
        start: ISO(start),
        end: ISO(end),
        bucket: "week",
        buckets: weeklyBuckets(start, end),
        label: `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`,
      };
    }
    case "trailing": {
      const n = Math.max(1, Math.min(52, Math.floor(trailingWeeks)));
      const end = endOfWeek(today, weekOpts);
      const start = startOfWeek(addWeeks(today, -(n - 1)), weekOpts);
      return {
        preset,
        start: ISO(start),
        end: ISO(end),
        bucket: "week",
        buckets: weeklyBuckets(start, end),
        label: `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")} (${n} weeks)`,
      };
    }
    case "this_quarter": {
      const start = startOfQuarter(today);
      const end = today;
      return {
        preset,
        start: ISO(start),
        end: ISO(end),
        bucket: "week",
        buckets: weeklyBuckets(start, end),
        label: `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")} (Q${Math.floor(today.getMonth() / 3) + 1})`,
      };
    }
    case "last_quarter": {
      const prev = subQuarters(today, 1);
      const start = startOfQuarter(prev);
      const end = endOfQuarter(prev);
      return {
        preset,
        start: ISO(start),
        end: ISO(end),
        bucket: "week",
        buckets: weeklyBuckets(start, end),
        label: `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")} (Q${Math.floor(prev.getMonth() / 3) + 1})`,
      };
    }
    case "ytd": {
      const start = startOfYear(today);
      const end = today;
      const sameDay = isSameDay(start, end);
      return {
        preset,
        start: ISO(start),
        end: ISO(end),
        bucket: "month",
        buckets: sameDay ? [] : monthlyBuckets(start, end),
        label: `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")} (YTD)`,
      };
    }
  }
}

export const PRESET_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: "this_week", label: "This Week" },
  { value: "last_week", label: "Last Week" },
  { value: "trailing", label: "Trailing Weeks" },
  { value: "this_quarter", label: "This Quarter" },
  { value: "last_quarter", label: "Last Quarter" },
  { value: "ytd", label: "YTD" },
];
