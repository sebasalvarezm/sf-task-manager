"use client";

import { RangePreset, PRESET_OPTIONS } from "@/lib/date-ranges";

type Props = {
  value: RangePreset;
  trailingN: number;
  onChange: (preset: RangePreset, trailingN: number) => void;
};

export default function RangePicker({ value, trailingN, onChange }: Props) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label className="text-sm font-medium text-navy">Range:</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as RangePreset, trailingN)}
        className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange min-w-[200px]"
      >
        {PRESET_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {value === "trailing" && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={52}
            value={trailingN}
            onChange={(e) =>
              onChange(
                value,
                Math.max(1, Math.min(52, parseInt(e.target.value) || 1))
              )
            }
            className="w-16 border border-gray-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
          />
          <span className="text-sm text-gray-500">weeks</span>
        </div>
      )}
    </div>
  );
}
