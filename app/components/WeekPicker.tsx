"use client";

/**
 * One control for picking a week: ‹ [Oct 19 – 25 · This week] ›.
 * The arrows step a week; the middle opens a small calendar where a whole
 * week row highlights and one click picks it.
 */
import { useEffect, useRef, useState } from "react";
import { addDays, addMonths, addWeeks, format, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const monday = (d: Date) => startOfWeek(d, { weekStartsOn: 1 });
const fromIso = (s: string) => new Date(`${s}T12:00:00`);

function rangeLabel(start: Date): string {
  const end = addDays(start, 6);
  return isSameMonth(start, end) ? `${format(start, "MMM d")} – ${format(end, "d")}` : `${format(start, "MMM d")} – ${format(end, "MMM d")}`;
}

function relative(start: Date): string | null {
  const diff = Math.round((start.getTime() - monday(new Date()).getTime()) / (7 * 86_400_000));
  if (diff === 0) return "This week";
  if (diff === -1) return "Last week";
  if (diff === 1) return "Next week";
  return null;
}

export default function WeekPicker({ value, onChange }: { value: string; onChange: (weekStart: string) => void }) {
  const selected = fromIso(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(selected));
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMonth(startOfMonth(selected));
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const thisMonday = monday(new Date());
  const rel = relative(selected);
  const weeks: Date[] = [];
  for (let w = monday(startOfMonth(month)); w <= addDays(startOfMonth(addMonths(month, 1)), -1); w = addWeeks(w, 1)) weeks.push(w);

  const pick = (d: Date) => {
    onChange(iso(d));
    setOpen(false);
  };

  return (
    <div ref={box} className="relative select-none">
      <div className="flex h-10 items-center rounded-full border border-line bg-white shadow-sm">
        <button
          type="button"
          aria-label="Previous week"
          onClick={() => onChange(iso(addWeeks(selected, -1)))}
          className="flex h-10 w-10 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <ChevronLeft size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-10 min-w-[190px] flex-col items-center justify-center rounded-full px-3 leading-tight transition-colors hover:bg-surface-3"
        >
          <span className="text-sm font-medium text-ink tabular-nums">{rangeLabel(selected)}</span>
          <span className="text-[11px] text-ink-secondary">{rel ?? format(selected, "yyyy")}</span>
        </button>
        <button
          type="button"
          aria-label="Next week"
          onClick={() => onChange(iso(addWeeks(selected, 1)))}
          className="flex h-10 w-10 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <ChevronRight size={18} strokeWidth={1.75} />
        </button>
      </div>
      {rel !== "This week" ? (
        <button
          type="button"
          onClick={() => onChange(iso(thisMonday))}
          className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] text-info hover:underline"
        >
          Back to this week
        </button>
      ) : null}

      {open ? (
        <div className="absolute right-0 top-12 z-50 w-[300px] rounded-2xl border border-line bg-white p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-sm font-medium text-ink">{format(month, "MMMM yyyy")}</span>
            <div className="flex">
              <button type="button" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))} className="flex h-8 w-8 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-3">
                <ChevronLeft size={16} />
              </button>
              <button type="button" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))} className="flex h-8 w-8 items-center justify-center rounded-full text-ink-secondary hover:bg-surface-3">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 px-1 pb-1 text-center text-[11px] text-ink-muted">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          <div className="space-y-0.5">
            {weeks.map((w) => {
              const isSel = iso(w) === value;
              const isNow = iso(w) === iso(thisMonday);
              return (
                <button
                  type="button"
                  key={iso(w)}
                  onClick={() => pick(w)}
                  className={`grid w-full grid-cols-7 rounded-full py-1.5 text-center text-sm tabular-nums transition-colors ${
                    isSel ? "bg-ink text-white" : "text-ink hover:bg-surface-3"
                  }`}
                >
                  {Array.from({ length: 7 }, (_, i) => {
                    const day = addDays(w, i);
                    const faded = !isSameMonth(day, month) && !isSel;
                    const today = iso(day) === iso(new Date());
                    return (
                      <span key={i} className={`${faded ? "text-ink-muted" : ""} ${today && !isSel ? "font-semibold text-info" : ""}`}>
                        {format(day, "d")}
                      </span>
                    );
                  })}
                  {isNow && !isSel ? <span className="sr-only">This week</span> : null}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between border-t border-line px-1 pt-2 text-xs">
            <button type="button" onClick={() => pick(addWeeks(thisMonday, -1))} className="text-ink-secondary hover:text-ink">
              Last week
            </button>
            <button type="button" onClick={() => pick(thisMonday)} className="font-medium text-info hover:underline">
              This week
            </button>
            <button type="button" onClick={() => pick(addWeeks(thisMonday, 1))} className="text-ink-secondary hover:text-ink">
              Next week
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
