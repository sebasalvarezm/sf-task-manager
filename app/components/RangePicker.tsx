"use client";

import { RangePreset, PRESET_OPTIONS } from "@/lib/date-ranges";

type Props = {
  value: RangePreset;
  onChange: (preset: RangePreset) => void;
};

export default function RangePicker({ value, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {PRESET_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={
              "px-4 py-2 rounded-full text-sm font-medium transition-colors border " +
              (active
                ? "bg-navy text-white border-navy"
                : "bg-white text-navy border-gray-200 hover:border-navy hover:bg-gray-50")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
